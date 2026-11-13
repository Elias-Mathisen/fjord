// Fjord's Windows installer, updater and uninstaller in one program (built by tools\build-installer.ps1).
//   FjordSetup.exe               shows the install window
//   FjordSetup.exe --update      no window: updates Fjord and Firefox when a new version is out (scheduled task)
//   FjordSetup.exe --uninstall   removes Fjord (from Windows' Installed apps): copies itself to %TEMP% and runs
//                                --uninstall-from <dir> from there, so it can delete Fjord's whole folder
//   FjordSetup.exe --install-to <dir>   test install into <dir>, without shortcuts, task or registry entry
//   FjordSetup.exe --update-in <dir>    the same update as --update, for a test install in <dir>
//                                       (FJORD_RELEASES=<url> checks that releases list instead of GitHub's)
//   FjordSetup.exe --uninstall-test <dir> [--delete-data]   the uninstall's clean-up for <dir>, without a window
//   FjordSetup.exe --snapshot <png> <state>   renders the window to a picture, for checking the design
//                                (ready, installing, failed, done, uninstall, removing, removed)
// Everything it does is logged to %LOCALAPPDATA%\Fjord\update.log (or %TEMP%\fjord-setup.log once that's gone).
// Installs per user into %LOCALAPPDATA%\Fjord (core\ = Firefox + Fjord, profile\ = the user's data), like Chrome.
// Compiled with the C# 5 compiler that ships with Windows, so no newer syntax.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography.X509Certificates;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Microsoft.Win32;

static class Program
{
    static readonly string DefaultRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Fjord");
    const string FirefoxUrl = "https://download.mozilla.org/?product=firefox-latest-ssl&os=win64&lang=en-US";
    const string VersionsUrl = "https://product-details.mozilla.org/1.0/firefox_versions.json";
    const string ReleasesUrl = "https://api.github.com/repos/Elias-Mathisen/fjord/releases/latest";
    const string TaskName = "Fjord update";
    const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Fjord";
    // Where Firefox keeps its start-up placeholder settings, one set of values per firefox.exe path
    const string SkeletonKey = @"Software\Mozilla\Firefox\PreXULSkeletonUISettings";

    // Only one copy installs, updates or uninstalls at a time, so the background updater never swaps files under the
    // install window (or the other way round)
    static System.Threading.Mutex busy;
    static bool Claim(int waitMs)
    {
        busy = new System.Threading.Mutex(false, @"Local\FjordSetup");
        try { return busy.WaitOne(waitMs); }
        catch (System.Threading.AbandonedMutexException) { return true; } // the last copy was ended mid-way
    }

    [STAThread]
    static int Main(string[] args)
    {
        // Tls13 isn't named in older .NET Framework versions
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12 | (SecurityProtocolType)12288;
        string mode = args.Length > 0 ? args[0] : "";
        AppDomain.CurrentDomain.UnhandledException += delegate (object s, UnhandledExceptionEventArgs e) { Log(DefaultRoot, "Crashed: " + e.ExceptionObject); };
        Action<string, double> console = delegate (string s, double p) { Console.WriteLine("{0:0}% {1}", p * 100, s); };
        try
        {
            if (mode == "--update") return Claim(60000) ? Update(DefaultRoot) : 0;
            if (mode == "--update-in" && args.Length > 1) return Claim(60000) ? Update(Path.GetFullPath(args[1])) : 0;
            if (mode == "--install-to" && args.Length > 1) { Install(Path.GetFullPath(args[1]), false, console); return 0; }
            if (mode == "--uninstall-test" && args.Length > 1) { Remove(Path.GetFullPath(args[1]), args.Length > 2 && args[2] == "--delete-data", console); return 0; }
            if (mode == "--snapshot" && args.Length > 2) { Snapshot(args[1], args[2]); return 0; }
            if (mode == "--uninstall" && RelaunchFromTemp(DefaultRoot)) return 0;
            var app = new Application();
            app.DispatcherUnhandledException += delegate (object s, System.Windows.Threading.DispatcherUnhandledExceptionEventArgs e)
            {
                Log(DefaultRoot, "Window error: " + e.Exception);
                e.Handled = true; // logged; the window stays open rather than vanishing
            };
            if (!Claim(0))
            {
                MessageBox.Show("Fjord Setup is already running. Finish it there first.", "Fjord", MessageBoxButton.OK, MessageBoxImage.Information);
                return 1;
            }
            bool uninstall = mode == "--uninstall" || mode == "--uninstall-from";
            string root = mode == "--uninstall-from" && args.Length > 1 ? Path.GetFullPath(args[1]) : DefaultRoot;
            app.Run(new SetupWindow(uninstall, root));
            if (mode == "--uninstall-from") ForgetSelf();
            return 0;
        }
        catch (Exception e)
        {
            Log(DefaultRoot, "Failed: " + e);
            if (mode == "" || mode == "--uninstall" || mode == "--uninstall-from") MessageBox.Show("Something went wrong:\n\n" + e.Message, "Fjord", MessageBoxButton.OK, MessageBoxImage.Error);
            return 1;
        }
    }

    // The uninstaller can't delete the folder it runs from, so it runs from a copy in %TEMP% instead
    static bool RelaunchFromTemp(string root)
    {
        string self = Assembly.GetExecutingAssembly().Location;
        if (!Path.GetFullPath(self).StartsWith(Path.GetFullPath(root) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) return false;
        string copy = Path.Combine(Path.GetTempPath(), "FjordUninstall-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".exe");
        File.Copy(self, copy, true);
        Process.Start(new ProcessStartInfo(copy, "--uninstall-from " + Quote(root)) { UseShellExecute = false });
        return true;
    }

    // The %TEMP% copy deletes itself once it has exited
    static void ForgetSelf()
    {
        string self = Assembly.GetExecutingAssembly().Location;
        if (!self.StartsWith(Path.GetTempPath(), StringComparison.OrdinalIgnoreCase)) return;
        Process.Start(new ProcessStartInfo("cmd.exe", "/c ping 127.0.0.1 -n 3 >nul & del /q " + Quote(self)) { CreateNoWindow = true, UseShellExecute = false });
    }

    // ---------- Install / update ----------

    public static void Install(string root, bool system, Action<string, double> progress)
    {
        string core = Path.Combine(root, "core");
        Directory.CreateDirectory(root);
        Log(root, "Installing Fjord " + PayloadVersion() + " into " + root);
        if (FjordRunning(core)) throw new Exception("Fjord is open. Close it, then try again.");

        string setup = DownloadFirefox(root, progress);
        progress("Unpacking Firefox…", 0.5);
        ReplaceCore(root, setup);
        progress("Adding Fjord…", 0.54);
        ApplyPayload(core);
        Directory.CreateDirectory(Path.Combine(root, "profile"));
        ClearStartupCache(root);
        if (!File.Exists(Path.Combine(core, "firefox.exe")) || !File.Exists(Path.Combine(core, "Fjord.cfg")))
            throw new Exception("Fjord's files didn't all arrive. Your antivirus may have held some back; try again.");

        if (system)
        {
            progress("Adding Fjord to the Start menu…", 0.9);
            string self = Path.Combine(root, "FjordSetup.exe");
            if (!string.Equals(Assembly.GetExecutingAssembly().Location, self, StringComparison.OrdinalIgnoreCase))
                Retry(delegate { File.Copy(Assembly.GetExecutingAssembly().Location, self, true); });
            CreateShortcuts(root);
            RegisterUninstall(root);
            // Firefox's pulsing placeholder window, off before the first start too (Fjord.cfg turns it off after that)
            using (var key = Registry.CurrentUser.CreateSubKey(SkeletonKey))
                key.SetValue(Path.Combine(core, "firefox.exe") + "|Enabled", 0, RegistryValueKind.DWord);
            // Every 3 hours, as this user; the updater has no window, so nothing flashes on screen
            Run("schtasks.exe", string.Format("/Create /F /SC HOURLY /MO 3 /TN \"{0}\" /TR \"\\\"{1}\\\" --update\"", TaskName, self));
        }
        Log(root, "Installed Fjord " + PayloadVersion() + ", Firefox " + FileVersionInfo.GetVersionInfo(Path.Combine(core, "firefox.exe")).ProductVersion);
        progress("Done", 1);
    }

    static int Update(string root)
    {
        string core = Path.Combine(root, "core");
        string exe = Path.Combine(core, "firefox.exe");
        if (!File.Exists(exe)) return 0;
        try { File.Delete(Path.Combine(root, "FjordSetup.old.exe")); } catch { } // left by the last self-update
        try { if (UpdateSelf(root)) return 0; } // the new copy carries on from here
        catch (Exception e) { Log(root, "Couldn't check for a new Fjord: " + e.Message); }

        string installed = FileVersionInfo.GetVersionInfo(exe).ProductVersion;
        string latest = LatestFirefox();
        bool newFirefox = latest != null && latest != installed;
        bool newFjord = InstalledVersion(core) != PayloadVersion();
        if (!newFirefox && !newFjord) return 0;
        if (FjordRunning(core)) return 0; // the next run tries again
        if (newFirefox)
        {
            Log(root, "Updating Firefox " + installed + " -> " + latest);
            string setup = DownloadFirefox(root, delegate { });
            ReplaceCore(root, setup);
        }
        if (newFjord) Log(root, "Updating Fjord " + InstalledVersion(core) + " -> " + PayloadVersion());
        ApplyPayload(core);
        ClearStartupCache(root);
        if (string.Equals(root, DefaultRoot, StringComparison.OrdinalIgnoreCase))
            CreateShortcuts(root, true); // their icon moved with Fjord's folder in 1.0.1
        RegisterUninstall(root); // refreshes the version shown in Installed apps
        Log(root, "Up to date: Fjord " + PayloadVersion() + ", Firefox " + FileVersionInfo.GetVersionInfo(exe).ProductVersion);
        return 0;
    }

    // Fjord's own updates: the FjordSetup.exe from the latest GitHub release, used only when it's newer than this one
    // and signed with Fjord's release key. It replaces this program, then runs the update with its own files.
    static bool UpdateSelf(string root)
    {
        string self = Path.Combine(root, "FjordSetup.exe");
        if (!string.Equals(Assembly.GetExecutingAssembly().Location, self, StringComparison.OrdinalIgnoreCase)) return false;
        using (var web = new WebClient())
        {
            web.Headers["User-Agent"] = "Fjord updater"; // GitHub's API refuses requests without one
            string json = web.DownloadString(Environment.GetEnvironmentVariable("FJORD_RELEASES") ?? ReleasesUrl);
            var tag = System.Text.RegularExpressions.Regex.Match(json, "\"tag_name\"\\s*:\\s*\"v?(\\d+(\\.\\d+){1,3})\"");
            if (!tag.Success || new Version(tag.Groups[1].Value) <= new Version(PayloadVersion())) return false;
            string version = tag.Groups[1].Value, exeUrl = Asset(json, "FjordSetup.exe"), sigUrl = Asset(json, "FjordSetup.exe.sig");
            if (exeUrl == null || sigUrl == null) return false;
            byte[] exe = web.DownloadData(exeUrl), sig = web.DownloadData(sigUrl);
            if (!SignedByFjord(exe, sig))
            {
                Log(root, "Ignored Fjord " + version + ": it isn't signed with Fjord's release key");
                return false;
            }
            string fresh = self + ".new", old = Path.Combine(root, "FjordSetup.old.exe");
            File.WriteAllBytes(fresh, exe);
            if (File.Exists(old)) File.Delete(old);
            File.Move(self, old); // a running program can be renamed, just not overwritten
            File.Move(fresh, self);
            Log(root, "Downloaded Fjord " + version);
            string args = string.Equals(root, DefaultRoot, StringComparison.OrdinalIgnoreCase) ? "--update" : "--update-in " + Quote(root);
            Process.Start(new ProcessStartInfo(self, args) { UseShellExecute = false, CreateNoWindow = true });
            return true;
        }
    }

    static string Asset(string json, string name)
    {
        var m = System.Text.RegularExpressions.Regex.Match(json, "\"browser_download_url\"\\s*:\\s*\"([^\"]+/" + System.Text.RegularExpressions.Regex.Escape(name) + ")\"");
        return m.Success ? m.Groups[1].Value : null;
    }

    // release-key.xml is the public half of the key tools\make-release-key.ps1 made; builds without it never self-update
    static bool SignedByFjord(byte[] data, byte[] signature)
    {
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("release-key.xml"))
        {
            if (stream == null) return false;
            using (var rsa = new System.Security.Cryptography.RSACryptoServiceProvider())
            {
                rsa.FromXmlString(new StreamReader(stream).ReadToEnd());
                return rsa.VerifyData(data, "SHA256", signature);
            }
        }
    }

    // Fjord's version: the one packed into this program, and the one installed in core\
    static string PayloadVersion()
    {
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
        using (var zip = new ZipArchive(stream))
        {
            var entry = zip.GetEntry("fjord/version.txt");
            if (entry == null) return "0.0";
            using (var reader = new StreamReader(entry.Open())) return reader.ReadToEnd().Trim();
        }
    }

    static string InstalledVersion(string core)
    {
        string file = Path.Combine(core, "fjord", "version.txt");
        return File.Exists(file) ? File.ReadAllText(file).Trim() : "";
    }

    // ---------- Uninstall ----------

    // Removes Fjord from root and every trace of it from Windows. The profile (bookmarks, history, passwords,
    // settings) stays unless deleteData. Each step carries on if one before it found nothing to remove.
    public static void Remove(string root, bool deleteData, Action<string, double> progress)
    {
        string core = Path.Combine(root, "core");
        Log(root, "Uninstalling Fjord from " + root + (deleteData ? ", with its data" : ""));
        progress("Closing Fjord…", 0.05);
        CloseFjord(core);
        progress("Removing the updater…", 0.15);
        if (string.Equals(root, DefaultRoot, StringComparison.OrdinalIgnoreCase))
            Run("schtasks.exe", string.Format("/Delete /F /TN \"{0}\"", TaskName));
        progress("Removing shortcuts…", 0.25);
        RemoveShortcuts(root);
        progress("Removing Fjord from Windows' settings…", 0.4);
        RemoveRegistration(core);
        if (string.Equals(root, DefaultRoot, StringComparison.OrdinalIgnoreCase))
            Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false);
        progress("Deleting Fjord's files…", 0.55);
        if (Directory.Exists(root))
        {
            foreach (string dir in Directory.GetDirectories(root))
                if (deleteData || !string.Equals(Path.GetFileName(dir), "profile", StringComparison.OrdinalIgnoreCase)) DeleteFolder(dir);
            progress("Deleting Fjord's files…", 0.9);
            string self = Assembly.GetExecutingAssembly().Location;
            foreach (string file in Directory.GetFiles(root))
                if (!string.Equals(file, self, StringComparison.OrdinalIgnoreCase) && (deleteData || !file.EndsWith(".log")))
                    Retry(delegate { File.SetAttributes(file, FileAttributes.Normal); File.Delete(file); });
            if (deleteData && Directory.GetFileSystemEntries(root).Length == 0) Retry(delegate { Directory.Delete(root); });
        }
        Log(root, "Uninstalled");
        progress("Done", 1);
    }

    // Asks Fjord's windows to close (so it saves your tabs), then ends whatever is left of it
    static void CloseFjord(string core)
    {
        var mine = FjordProcesses(core);
        if (mine.Count == 0) return;
        foreach (var p in mine) try { p.CloseMainWindow(); } catch { }
        var deadline = DateTime.Now.AddSeconds(5); // one wait for all of them, not five seconds each
        while (DateTime.Now < deadline && mine.Any(p => { try { return !p.HasExited; } catch { return false; } }))
            System.Threading.Thread.Sleep(200);
        foreach (var p in FjordProcesses(core)) try { p.Kill(); } catch { }
        foreach (var p in FjordProcesses(core)) try { p.WaitForExit(3000); } catch { }
    }

    static List<Process> FjordProcesses(string core)
    {
        string dir = Path.GetFullPath(core) + Path.DirectorySeparatorChar;
        var list = new List<Process>();
        foreach (var p in Process.GetProcesses())
        {
            try { if (p.MainModule.FileName.StartsWith(dir, StringComparison.OrdinalIgnoreCase)) list.Add(p); }
            catch { } // system processes and other users' can't be inspected
        }
        return list;
    }

    // Fjord's shortcuts in the Start menu, on the desktop and pinned to the taskbar or Start: any that open something
    // in Fjord's folder, plus the private-browsing one Firefox itself made in old versions
    static void RemoveShortcuts(string root)
    {
        string inside = Path.GetFullPath(root) + Path.DirectorySeparatorChar;
        string pinned = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), @"Microsoft\Internet Explorer\Quick Launch");
        var places = new[] { Environment.GetFolderPath(Environment.SpecialFolder.Programs), Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), pinned };
        dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
        foreach (string place in places)
        {
            if (!Directory.Exists(place)) continue;
            foreach (string lnk in Directory.GetFiles(place, "*.lnk", SearchOption.AllDirectories))
            {
                try
                {
                    string target = (string)shell.CreateShortcut(lnk).TargetPath;
                    bool ours = target.StartsWith(inside, StringComparison.OrdinalIgnoreCase)
                        || (Path.GetFileName(lnk) == "Fjord Private Browsing.lnk" && !File.Exists(target));
                    if (ours) File.Delete(lnk);
                }
                catch { }
            }
        }
    }

    // What Firefox and Fjord registered for this copy: its entry in Windows' list of browsers (Default apps), the
    // file and link types it can open, and Firefox's per-copy settings. Only keys pointing into this copy's folder.
    static void RemoveRegistration(string core)
    {
        string inside = Path.GetFullPath(core) + Path.DirectorySeparatorChar;
        var hkcu = Registry.CurrentUser;
        var browsers = new List<string>();
        var progIds = new List<string>();
        using (var list = hkcu.OpenSubKey(@"Software\Clients\StartMenuInternet", true))
            if (list != null)
                foreach (string name in list.GetSubKeyNames())
                    if (OpensFrom(list, name, inside)) { browsers.Add(name); list.DeleteSubKeyTree(name, false); }
        using (var apps = hkcu.OpenSubKey(@"Software\RegisteredApplications", true))
            if (apps != null)
                foreach (string value in apps.GetValueNames())
                {
                    string path = apps.GetValue(value) as string;
                    if (path != null && browsers.Any(b => path.IndexOf(@"\StartMenuInternet\" + b + @"\", StringComparison.OrdinalIgnoreCase) >= 0))
                        apps.DeleteValue(value, false);
                }
        using (var classes = hkcu.OpenSubKey(@"Software\Classes", true))
            if (classes != null)
            {
                foreach (string name in classes.GetSubKeyNames())
                    if ((name.StartsWith("Firefox", StringComparison.OrdinalIgnoreCase) || name.StartsWith("Fjord", StringComparison.OrdinalIgnoreCase))
                        && OpensFrom(classes, name, inside)) { progIds.Add(name); classes.DeleteSubKeyTree(name, false); }
                foreach (string ext in new[] { ".htm", ".html", ".shtml", ".xht", ".xhtml", ".svg", ".webp", ".avif", ".pdf" })
                    using (var open = classes.OpenSubKey(ext + @"\OpenWithProgids", true))
                        if (open != null) foreach (string id in progIds) open.DeleteValue(id, false);
            }
        // Firefox's own per-copy values are named after its path (taskbar ID, start-up window, launcher)
        using (var mozilla = hkcu.OpenSubKey(@"Software\Mozilla", true))
            if (mozilla != null) RemoveValuesNaming(mozilla, inside, 0);
        SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero); // tells Windows its file types changed
    }

    static bool OpensFrom(RegistryKey parent, string name, string inside)
    {
        try
        {
            using (var command = parent.OpenSubKey(name + @"\shell\open\command"))
            {
                string line = command == null ? null : command.GetValue("") as string;
                return line != null && line.IndexOf(inside, StringComparison.OrdinalIgnoreCase) >= 0;
            }
        }
        catch { return false; }
    }

    static void RemoveValuesNaming(RegistryKey key, string inside, int depth)
    {
        string folder = inside.TrimEnd(Path.DirectorySeparatorChar);
        foreach (string value in key.GetValueNames())
            if (value.IndexOf(inside, StringComparison.OrdinalIgnoreCase) >= 0 || string.Equals(value, folder, StringComparison.OrdinalIgnoreCase))
                key.DeleteValue(value, false);
        if (depth >= 3) return;
        foreach (string name in key.GetSubKeyNames())
            using (var sub = key.OpenSubKey(name, true)) if (sub != null) RemoveValuesNaming(sub, inside, depth + 1);
    }

    [DllImport("shell32.dll")]
    static extern void SHChangeNotify(int eventId, int flags, IntPtr item1, IntPtr item2);

    static string LatestFirefox()
    {
        try
        {
            using (var web = new WebClient())
            {
                string json = web.DownloadString(VersionsUrl);
                var m = System.Text.RegularExpressions.Regex.Match(json, "\"LATEST_FIREFOX_VERSION\"\\s*:\\s*\"([^\"]+)\"");
                return m.Success ? m.Groups[1].Value : null;
            }
        }
        catch { return null; }
    }

    // Downloads Mozilla's installer and refuses anything not validly signed by Mozilla. A stalled connection gives up
    // after 30 seconds instead of hanging, and a dropped one is tried three times.
    static string DownloadFirefox(string root, Action<string, double> progress)
    {
        string path = Path.Combine(Path.GetTempPath(), "fjord-firefox-" + Guid.NewGuid().ToString("N") + ".exe");
        for (int attempt = 1; ; attempt++)
        {
            try
            {
                progress("Downloading Firefox from Mozilla…", 0.05);
                Download(FirefoxUrl, path, delegate (double f) { progress("Downloading Firefox from Mozilla…", 0.05 + 0.4 * f); });
                break;
            }
            catch (Exception e)
            {
                Log(root, "Download attempt " + attempt + " failed: " + e.Message);
                try { File.Delete(path); } catch { }
                if (attempt >= 3) throw new Exception("Firefox couldn't be downloaded from Mozilla. Check your internet connection, then try again.");
                progress("The connection dropped. Trying again…", 0.05);
                System.Threading.Thread.Sleep(2000 * attempt);
            }
        }
        progress("Checking Mozilla's signature…", 0.47);
        if (!SignedByMozilla(path))
        {
            File.Delete(path);
            throw new Exception("The downloaded Firefox isn't validly signed by Mozilla, so it wasn't installed.");
        }
        return path;
    }

    // Reads url into path, reporting 0..1 as it goes (only when the whole percent changes, so the window keeps up)
    static void Download(string url, string path, Action<double> progress)
    {
        var request = (HttpWebRequest)WebRequest.Create(url);
        request.UserAgent = "Fjord Setup";
        request.Timeout = 30000;
        request.ReadWriteTimeout = 30000;
        using (var response = (HttpWebResponse)request.GetResponse())
        using (var from = response.GetResponseStream())
        using (var to = File.Create(path))
        {
            long total = response.ContentLength, got = 0;
            int shown = -1, n;
            var buffer = new byte[81920];
            while ((n = from.Read(buffer, 0, buffer.Length)) > 0)
            {
                to.Write(buffer, 0, n);
                got += n;
                int percent = total > 0 ? (int)(got * 100 / total) : 0;
                if (percent != shown) { shown = percent; progress(percent / 100.0); }
            }
            if (total > 0 && got != total) throw new IOException("The download stopped early.");
        }
    }

    // Antivirus programs briefly lock files they're checking; moving or deleting one then fails, so it's tried again
    static void Retry(Action step)
    {
        for (int attempt = 1; ; attempt++)
        {
            try { step(); return; }
            catch (Exception e)
            {
                if (!(e is IOException || e is UnauthorizedAccessException) || attempt >= 8) throw;
                System.Threading.Thread.Sleep(250 * attempt);
            }
        }
    }

    // Directory.Delete stops at read-only files, which Firefox's folder can have, and at paths longer than 260
    // characters, which a profile's site storage can reach; Windows' own rmdir handles both
    static void DeleteFolder(string dir)
    {
        if (!Directory.Exists(dir)) return;
        try
        {
            foreach (string f in Directory.GetFiles(dir, "*", SearchOption.AllDirectories))
                try { File.SetAttributes(f, FileAttributes.Normal); } catch { }
            Directory.Delete(dir, true);
            return;
        }
        catch (Exception e)
        {
            if (!(e is IOException || e is UnauthorizedAccessException)) throw;
        }
        // rmdir with \\?\ takes any path length; a file an antivirus is still checking gets a few more seconds
        for (int attempt = 1; attempt <= 4 && Directory.Exists(dir); attempt++)
        {
            Run("cmd.exe", "/c rmdir /s /q " + Quote(@"\\?\" + Path.GetFullPath(dir)));
            if (Directory.Exists(dir)) System.Threading.Thread.Sleep(750 * attempt);
        }
        if (Directory.Exists(dir)) throw new IOException("Some of Fjord's files are still in use, so " + dir + " couldn't be deleted. Restart your computer, then uninstall again.");
    }

    // Extracts next to the old copy and swaps only once that worked; the profile folder is never touched
    static void ReplaceCore(string root, string setup)
    {
        string stage = Path.Combine(root, "staging");
        DeleteFolder(stage);
        DeleteFolder(Path.Combine(root, "core-old")); // left by an install that was cut off
        // Unpacked with Windows' own tar (it reads Mozilla's 7-Zip installer): running the installer itself
        // would pop up Mozilla's "Firefox Installer" window
        Directory.CreateDirectory(stage);
        var p = Process.Start(new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "tar.exe"),
            "-xf " + Quote(setup) + " -C " + Quote(stage) + " core") { UseShellExecute = false, CreateNoWindow = true });
        p.WaitForExit();
        if (p.ExitCode != 0) Log(root, "tar exited with " + p.ExitCode);
        try { File.Delete(setup); } catch { }
        string fresh = Path.Combine(stage, "core");
        if (!File.Exists(Path.Combine(fresh, "firefox.exe"))) throw new Exception("Firefox couldn't be unpacked. Try again; if it keeps failing, your antivirus may be blocking it.");
        string core = Path.Combine(root, "core");
        RenameOldFolder(core);
        // The new-tab photos were downloaded separately; carried over so an update doesn't fetch them again
        string photos = Path.Combine(core, "fjord", "photos");
        if (Directory.Exists(photos))
        {
            Directory.CreateDirectory(Path.Combine(fresh, "fjord"));
            Retry(delegate { Directory.Move(photos, Path.Combine(fresh, "fjord", "photos")); });
        }
        if (Directory.Exists(core))
        {
            string old = core + "-old";
            Retry(delegate { Directory.Move(core, old); });
            Retry(delegate { Directory.Move(fresh, core); });
            try { DeleteFolder(old); } catch (Exception e) { Log(root, "Couldn't remove the old copy yet: " + e.Message); }
        }
        else Retry(delegate { Directory.Move(fresh, core); });
        DeleteFolder(stage);
    }

    // Fjord's own files (config, theme, icons), packed into this program by build-installer.ps1
    static void ApplyPayload(string core)
    {
        RenameOldFolder(core);
        string full = Path.GetFullPath(core) + Path.DirectorySeparatorChar;
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
        using (var zip = new ZipArchive(stream))
        {
            foreach (var entry in zip.Entries)
            {
                if (entry.FullName.EndsWith("/")) continue;
                string target = Path.GetFullPath(Path.Combine(core, entry.FullName));
                if (!target.StartsWith(full, StringComparison.OrdinalIgnoreCase)) continue; // never outside core\
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                entry.ExtractToFile(target, true);
            }
        }
    }

    // Up to 1.0.0 Fjord's files were in core\nocturne\ (its old name): the downloaded photos move to core\fjord\,
    // the rest is replaced by the payload
    static void RenameOldFolder(string core)
    {
        string old = Path.Combine(core, "nocturne");
        if (!Directory.Exists(old)) return;
        string photos = Path.Combine(old, "photos"), fresh = Path.Combine(core, "fjord", "photos");
        if (Directory.Exists(photos) && !Directory.Exists(fresh))
        {
            Directory.CreateDirectory(Path.Combine(core, "fjord"));
            Directory.Move(photos, fresh);
        }
        Directory.Delete(old, true);
        File.Delete(Path.Combine(core, "nocturne.cfg"));
    }

    // Firefox caches its translated window per profile; cleared so a new version's text shows right away
    static void ClearStartupCache(string root)
    {
        string cache = Path.Combine(root, "profile", "startupCache");
        if (Directory.Exists(cache)) Directory.Delete(cache, true);
    }

    public static bool IsRunning(string root) { return FjordRunning(Path.Combine(root, "core")); }

    static bool FjordRunning(string core)
    {
        string dir = Path.GetFullPath(core) + Path.DirectorySeparatorChar;
        foreach (var p in Process.GetProcessesByName("firefox"))
        {
            try { if (p.MainModule.FileName.StartsWith(dir, StringComparison.OrdinalIgnoreCase)) return true; }
            catch { } // processes of other users can't be inspected
        }
        return false;
    }

    static string[] ShortcutPaths()
    {
        return new[] {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Fjord.lnk"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Fjord.lnk"),
        };
    }

    // Fjord replaces the Start menu one on first start with a copy that carries its taskbar ID
    // onlyExisting: refresh the shortcuts that are there, without bringing back one the user deleted
    static void CreateShortcuts(string root, bool onlyExisting = false)
    {
        dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
        foreach (string path in ShortcutPaths())
        {
            if (onlyExisting && !File.Exists(path)) continue;
            dynamic lnk = shell.CreateShortcut(path);
            lnk.TargetPath = Path.Combine(root, "core", "firefox.exe");
            lnk.Arguments = "-profile " + Quote(Path.Combine(root, "profile"));
            lnk.WorkingDirectory = Path.Combine(root, "core");
            lnk.IconLocation = Path.Combine(root, "core", "fjord", "fjord.ico") + ",0";
            lnk.Description = "Fjord";
            lnk.Save();
        }
    }

    static void RegisterUninstall(string root)
    {
        using (var key = Registry.CurrentUser.CreateSubKey(UninstallKey))
        {
            key.SetValue("DisplayName", "Fjord");
            key.SetValue("DisplayIcon", Path.Combine(root, "core", "fjord", "fjord.ico"));
            key.SetValue("DisplayVersion", PayloadVersion());
            key.SetValue("Publisher", "Fjord");
            key.SetValue("InstallLocation", root);
            key.SetValue("UninstallString", Quote(Path.Combine(root, "FjordSetup.exe")) + " --uninstall");
            key.SetValue("NoModify", 1, RegistryValueKind.DWord);
            key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        }
    }

    public static void Launch(string root)
    {
        Process.Start(new ProcessStartInfo(Path.Combine(root, "core", "firefox.exe"), "-profile " + Quote(Path.Combine(root, "profile"))) { UseShellExecute = false });
    }

    static void Run(string file, string arguments)
    {
        var p = Process.Start(new ProcessStartInfo(file, arguments) { CreateNoWindow = true, UseShellExecute = false });
        p.WaitForExit();
    }

    static string Quote(string s) { return "\"" + s + "\""; }

    // Into the Fjord folder while there is one; after an uninstall, into %TEMP%
    public static void Log(string root, string line)
    {
        try
        {
            string file = Directory.Exists(root) ? Path.Combine(root, "update.log") : Path.Combine(Path.GetTempPath(), "fjord-setup.log");
            File.AppendAllText(file, DateTime.Now.ToString("u") + " " + line + Environment.NewLine);
        }
        catch { }
    }

    // ---------- Signature check (WinVerifyTrust) ----------

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    class FileInfo { public uint cbStruct = (uint)Marshal.SizeOf(typeof(FileInfo)); public string path; public IntPtr file = IntPtr.Zero; public IntPtr subject = IntPtr.Zero; }

    [StructLayout(LayoutKind.Sequential)]
    class TrustData
    {
        public uint cbStruct = (uint)Marshal.SizeOf(typeof(TrustData));
        public IntPtr policyCallback = IntPtr.Zero, sipClient = IntPtr.Zero;
        public uint uiChoice = 2; // no UI
        public uint revocationChecks = 0;
        public uint unionChoice = 1; // file
        public IntPtr fileInfo;
        public uint stateAction = 0, dummy = 0;
        public IntPtr stateData = IntPtr.Zero;
        public string urlReference = null;
        public uint provFlags = 0x10; // revocation check on the whole chain
        public uint uiContext = 0;
    }

    [DllImport("wintrust.dll", CharSet = CharSet.Unicode)]
    static extern int WinVerifyTrust(IntPtr hwnd, [MarshalAs(UnmanagedType.LPStruct)] Guid action, [In] TrustData data);

    static bool SignedByMozilla(string path)
    {
        var info = new FileInfo { path = path };
        IntPtr pInfo = Marshal.AllocHGlobal(Marshal.SizeOf(info));
        try
        {
            Marshal.StructureToPtr(info, pInfo, false);
            var genericVerifyV2 = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
            if (WinVerifyTrust(IntPtr.Zero, genericVerifyV2, new TrustData { fileInfo = pInfo }) != 0) return false;
            return X509Certificate.CreateFromSignedFile(path).Subject.Contains("O=Mozilla Corporation");
        }
        finally { Marshal.FreeHGlobal(pInfo); }
    }

    // ---------- Design check ----------

    static void Snapshot(string png, string state)
    {
        var w = new SetupWindow(state == "uninstall" || state == "removing" || state == "removed", DefaultRoot);
        w.Preview(state);
        var root = (FrameworkElement)w.Content;
        root.Measure(new Size(w.Width, w.Height));
        root.Arrange(new Rect(0, 0, w.Width, w.Height));
        root.UpdateLayout();
        var bmp = new RenderTargetBitmap((int)w.Width * 2, (int)w.Height * 2, 192, 192, PixelFormats.Pbgra32);
        bmp.Render(root);
        var enc = new PngBitmapEncoder();
        enc.Frames.Add(BitmapFrame.Create(bmp));
        using (var f = File.Create(png)) enc.Save(f);
    }

    public static BitmapImage Picture(string name)
    {
        var img = new BitmapImage();
        img.BeginInit();
        img.StreamSource = Assembly.GetExecutingAssembly().GetManifestResourceStream(name);
        img.CacheOption = BitmapCacheOption.OnLoad;
        img.EndInit();
        return img;
    }

    public static string Root { get { return DefaultRoot; } }
}

// The window for installing and uninstalling, laid out like the README: the fjord drawing across the top, the logo
// in the middle under it, what's happening below that, and a progress bar along the bottom while it works.
// It can't be closed while it's working, so an install or uninstall is never left half done.
class SetupWindow : Window
{
    const string Xaml = @"
<Border xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation' xmlns:x='http://schemas.microsoft.com/winfx/2006/xaml'
        CornerRadius='18' Background='#FFFFFF' BorderBrush='#DCDCE0' BorderThickness='1'>
  <Border.Resources>
    <Style x:Key='Primary' TargetType='Button'>
      <Setter Property='Foreground' Value='#FFFFFF'/>
      <Setter Property='FontSize' Value='15'/>
      <Setter Property='FontWeight' Value='SemiBold'/>
      <Setter Property='Cursor' Value='Hand'/>
      <Setter Property='MinWidth' Value='132'/>
      <Setter Property='Template'>
        <Setter.Value>
          <ControlTemplate TargetType='Button'>
            <Border x:Name='b' Background='#1D1D1F' CornerRadius='12' Padding='26,12' BorderBrush='Transparent' BorderThickness='2'>
              <ContentPresenter HorizontalAlignment='Center' VerticalAlignment='Center'/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property='IsMouseOver' Value='True'><Setter TargetName='b' Property='Background' Value='#000000'/></Trigger>
              <Trigger Property='IsPressed' Value='True'><Setter TargetName='b' Property='Background' Value='#3A3A3D'/></Trigger>
              <Trigger Property='IsKeyboardFocused' Value='True'><Setter TargetName='b' Property='BorderBrush' Value='#8AB4F8'/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key='Link' TargetType='Button'>
      <Setter Property='Foreground' Value='#6E6E73'/>
      <Setter Property='FontSize' Value='14'/>
      <Setter Property='FontWeight' Value='Medium'/>
      <Setter Property='Cursor' Value='Hand'/>
      <Setter Property='Template'>
        <Setter.Value>
          <ControlTemplate TargetType='Button'>
            <Border x:Name='b' Background='Transparent' CornerRadius='10' Padding='16,12' BorderBrush='Transparent' BorderThickness='2'>
              <ContentPresenter HorizontalAlignment='Center' VerticalAlignment='Center'/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property='IsMouseOver' Value='True'><Setter Property='Foreground' Value='#1D1D1F'/><Setter TargetName='b' Property='Background' Value='#0D000000'/></Trigger>
              <Trigger Property='IsKeyboardFocused' Value='True'><Setter TargetName='b' Property='BorderBrush' Value='#8AB4F8'/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key='Quiet' TargetType='Button'>
      <Setter Property='Foreground' Value='#3A3A3D'/>
      <Setter Property='FontSize' Value='14'/>
      <Setter Property='Cursor' Value='Hand'/>
      <Setter Property='Template'>
        <Setter.Value>
          <ControlTemplate TargetType='Button'>
            <Border x:Name='b' Background='#B3FFFFFF' CornerRadius='16' Width='32' Height='32'>
              <ContentPresenter HorizontalAlignment='Center' VerticalAlignment='Center'/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property='IsMouseOver' Value='True'><Setter TargetName='b' Property='Background' Value='#FFFFFFFF'/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key='Box' TargetType='CheckBox'>
      <Setter Property='Foreground' Value='#1D1D1F'/>
      <Setter Property='FontSize' Value='13'/>
      <Setter Property='Cursor' Value='Hand'/>
      <Setter Property='Template'>
        <Setter.Value>
          <ControlTemplate TargetType='CheckBox'>
            <StackPanel Orientation='Horizontal' Background='Transparent'>
              <Grid Width='20' Height='20' VerticalAlignment='Top' Margin='0,1,0,0'>
                <Border x:Name='box' CornerRadius='6' Background='#FFFFFF' BorderBrush='#C7C7CC' BorderThickness='1.5'/>
                <Path x:Name='tick' Data='M5.5,10.5 L8.5,13.5 L14.5,7' Stroke='White' StrokeThickness='2' StrokeStartLineCap='Round' StrokeEndLineCap='Round' StrokeLineJoin='Round' Visibility='Collapsed'/>
              </Grid>
              <ContentPresenter Margin='10,0,0,0' VerticalAlignment='Center'/>
            </StackPanel>
            <ControlTemplate.Triggers>
              <Trigger Property='IsChecked' Value='True'>
                <Setter TargetName='box' Property='Background' Value='#1D1D1F'/>
                <Setter TargetName='box' Property='BorderBrush' Value='#1D1D1F'/>
                <Setter TargetName='tick' Property='Visibility' Value='Visible'/>
              </Trigger>
              <Trigger Property='IsKeyboardFocused' Value='True'><Setter TargetName='box' Property='BorderBrush' Value='#8AB4F8'/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key='Heading' TargetType='TextBlock'>
      <Setter Property='FontSize' Value='19'/>
      <Setter Property='FontWeight' Value='SemiBold'/>
      <Setter Property='Foreground' Value='#1D1D1F'/>
      <Setter Property='HorizontalAlignment' Value='Center'/>
    </Style>
    <Style x:Key='Body' TargetType='TextBlock'>
      <Setter Property='FontSize' Value='13'/>
      <Setter Property='Foreground' Value='#6E6E73'/>
      <Setter Property='LineHeight' Value='20'/>
      <Setter Property='TextWrapping' Value='Wrap'/>
      <Setter Property='TextAlignment' Value='Center'/>
      <Setter Property='MaxWidth' Value='420'/>
      <Setter Property='HorizontalAlignment' Value='Center'/>
      <Setter Property='Margin' Value='0,8,0,0'/>
    </Style>
    <Style x:Key='Buttons' TargetType='StackPanel'>
      <Setter Property='Orientation' Value='Horizontal'/>
      <Setter Property='HorizontalAlignment' Value='Center'/>
      <Setter Property='Margin' Value='0,22,0,0'/>
    </Style>
  </Border.Resources>
  <Grid>
    <Grid.RowDefinitions><RowDefinition Height='150'/><RowDefinition Height='*'/><RowDefinition Height='Auto'/></Grid.RowDefinitions>

    <!-- The fjord drawing, fading into the window at the bottom -->
    <Border x:Name='Band' CornerRadius='17,17,0,0'/>
    <Border CornerRadius='17,17,0,0'>
      <Border.Background>
        <LinearGradientBrush StartPoint='0,0' EndPoint='0,1'>
          <GradientStop Color='#00FFFFFF' Offset='0.35'/>
          <GradientStop Color='#FFFFFFFF' Offset='1'/>
        </LinearGradientBrush>
      </Border.Background>
    </Border>
    <Button x:Name='Close' Style='{StaticResource Quiet}' Content='✕' HorizontalAlignment='Right' VerticalAlignment='Top' Margin='0,14,14,0' ToolTip='Close'/>

    <StackPanel Grid.Row='1' Margin='40,-58,40,0'>
      <Border HorizontalAlignment='Center' CornerRadius='20'>
        <Border.Effect><DropShadowEffect BlurRadius='24' ShadowDepth='6' Direction='270' Opacity='0.18'/></Border.Effect>
        <Image x:Name='Logo' Width='84' Height='84' RenderOptions.BitmapScalingMode='HighQuality'/>
      </Border>
      <TextBlock Text='Fjord' FontSize='28' FontWeight='SemiBold' Foreground='#1D1D1F' HorizontalAlignment='Center' Margin='0,12,0,0'/>
      <TextBlock x:Name='Tagline' Text='A private browser built on Firefox' FontSize='14' Foreground='#6E6E73' HorizontalAlignment='Center' Margin='0,2,0,0'/>

      <StackPanel x:Name='Ready' Margin='0,20,0,0'>
        <TextBlock Style='{StaticResource Body}' Text='Ads and trackers are blocked from the first page you open. It installs for your account only, needs no admin password, and keeps itself up to date.'/>
        <StackPanel Style='{StaticResource Buttons}'>
          <Button x:Name='Install' Style='{StaticResource Primary}' Content='Install'/>
        </StackPanel>
      </StackPanel>

      <StackPanel x:Name='Busy' Margin='0,26,0,0' Visibility='Collapsed'>
        <TextBlock x:Name='BusyTitle' Style='{StaticResource Heading}' Text='Installing Fjord'/>
        <TextBlock Style='{StaticResource Body}' x:Name='BusyText' Text='This takes a minute or two. Leave this window open until it&#x2019;s done.'/>
        <StackPanel x:Name='Failed' Visibility='Collapsed'>
          <TextBlock x:Name='Error' Style='{StaticResource Body}' Foreground='#B3261E'/>
          <StackPanel Style='{StaticResource Buttons}'>
            <Button x:Name='Retry' Style='{StaticResource Primary}' Content='Try again'/>
            <Button x:Name='GiveUp' Style='{StaticResource Link}' Content='Close' Margin='8,0,0,0'/>
          </StackPanel>
        </StackPanel>
      </StackPanel>

      <StackPanel x:Name='Done' Margin='0,26,0,0' Visibility='Collapsed'>
        <TextBlock Style='{StaticResource Heading}' Text='Fjord is ready'/>
        <TextBlock Style='{StaticResource Body}' Text='It&#x2019;s in the Start menu and on your desktop, and keeps itself up to date.'/>
        <StackPanel Style='{StaticResource Buttons}'>
          <Button x:Name='Open' Style='{StaticResource Primary}' Content='Open Fjord'/>
          <Button x:Name='Later' Style='{StaticResource Link}' Content='Close' Margin='8,0,0,0'/>
        </StackPanel>
      </StackPanel>

      <StackPanel x:Name='Ask' Margin='0,22,0,0' Visibility='Collapsed'>
        <TextBlock Style='{StaticResource Heading}' Text='Uninstall Fjord?'/>
        <TextBlock x:Name='AskText' Style='{StaticResource Body}' Text='Fjord, its shortcuts and its updater will be removed from this computer.'/>
        <CheckBox x:Name='DeleteData' Style='{StaticResource Box}' HorizontalAlignment='Center' Margin='0,16,0,0' Content='Also delete my bookmarks, history, passwords and settings'/>
        <StackPanel Style='{StaticResource Buttons}'>
          <Button x:Name='Uninstall' Style='{StaticResource Primary}' Content='Uninstall'/>
          <Button x:Name='Keep' Style='{StaticResource Link}' Content='Cancel' Margin='8,0,0,0'/>
        </StackPanel>
      </StackPanel>

      <StackPanel x:Name='Removed' Margin='0,26,0,0' Visibility='Collapsed'>
        <TextBlock Style='{StaticResource Heading}' Text='Fjord has been removed'/>
        <TextBlock x:Name='RemovedText' Style='{StaticResource Body}'/>
        <StackPanel Style='{StaticResource Buttons}'>
          <Button x:Name='Finish' Style='{StaticResource Primary}' Content='Close'/>
        </StackPanel>
      </StackPanel>
    </StackPanel>

    <!-- What it's doing, and how far along it is -->
    <StackPanel x:Name='Meter' Grid.Row='2' Margin='40,0,40,30' Visibility='Collapsed'>
      <Grid Margin='0,0,0,10'>
        <TextBlock x:Name='Status' FontSize='12' Foreground='#6E6E73' TextTrimming='CharacterEllipsis' Margin='0,0,48,0'/>
        <TextBlock x:Name='Percent' FontSize='12' Foreground='#1D1D1F' FontWeight='SemiBold' HorizontalAlignment='Right'/>
      </Grid>
      <Grid Height='6'>
        <Grid.ColumnDefinitions><ColumnDefinition x:Name='Filled' Width='0*'/><ColumnDefinition x:Name='Rest' Width='1*'/></Grid.ColumnDefinitions>
        <Border Grid.ColumnSpan='2' CornerRadius='3' Background='#EBEBEE'/>
        <Border CornerRadius='3' Background='#1D1D1F'/>
      </Grid>
    </StackPanel>
  </Grid>
</Border>";

    readonly Border root;
    readonly bool uninstall;
    readonly string fjordRoot;
    bool working;
    T Find<T>(string name) where T : class { return (T)root.FindName(name); }

    public SetupWindow(bool uninstall, string fjordRoot)
    {
        this.uninstall = uninstall;
        this.fjordRoot = fjordRoot;
        Title = uninstall ? "Uninstall Fjord" : "Fjord Setup";
        Width = 560;
        Height = 470;
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        ResizeMode = ResizeMode.NoResize;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        FontFamily = new FontFamily("Segoe UI Variable Display, Segoe UI");
        Icon = Program.Picture("logo.png");
        root = (Border)XamlReader.Parse(Xaml);
        Content = root;
        Find<Border>("Band").Background = new ImageBrush(Program.Picture("fjord-wide.jpg")) { Stretch = Stretch.UniformToFill, AlignmentY = AlignmentY.Center };
        Find<Image>("Logo").Source = Program.Picture("logo.png");

        Find<Button>("Close").Click += delegate { Close(); };
        Find<Button>("Later").Click += delegate { Close(); };
        Find<Button>("GiveUp").Click += delegate { Close(); };
        Find<Button>("Keep").Click += delegate { Close(); };
        Find<Button>("Finish").Click += delegate { Close(); };
        Find<Button>("Install").Click += delegate { Start(); };
        Find<Button>("Uninstall").Click += delegate { Start(); };
        Find<Button>("Retry").Click += delegate { Start(); };
        Find<Button>("Open").Click += delegate { Program.Launch(fjordRoot); Close(); };
        Closing += delegate (object s, System.ComponentModel.CancelEventArgs e) { if (working) e.Cancel = true; };
        MouseLeftButtonDown += delegate (object s, MouseButtonEventArgs e)
        {
            try { if (e.ButtonState == MouseButtonState.Pressed) DragMove(); } catch (InvalidOperationException) { }
        };

        if (uninstall)
        {
            Show("Ask");
            if (Program.IsRunning(fjordRoot))
            {
                Find<TextBlock>("AskText").Text = "Fjord is open. It will be closed first, then Fjord, its shortcuts and its updater are removed.";
                Find<Button>("Uninstall").Content = "Close Fjord and uninstall";
            }
            Loaded += delegate { Find<Button>("Uninstall").Focus(); };
        }
        else
        {
            Show("Ready");
            Loaded += delegate { Find<Button>("Install").Focus(); };
        }
    }

    void Show(string panel)
    {
        foreach (var name in new[] { "Ready", "Busy", "Done", "Ask", "Removed" })
            Find<UIElement>(name).Visibility = name == panel ? Visibility.Visible : Visibility.Collapsed;
        Find<UIElement>("Tagline").Visibility = panel == "Ready" ? Visibility.Visible : Visibility.Collapsed;
    }

    void SetProgress(string status, double p)
    {
        p = Math.Max(0, Math.Min(1, p));
        Find<ColumnDefinition>("Filled").Width = new GridLength(p, GridUnitType.Star);
        Find<ColumnDefinition>("Rest").Width = new GridLength(1 - p, GridUnitType.Star);
        Find<TextBlock>("Status").Text = status;
        Find<TextBlock>("Percent").Text = (int)Math.Round(p * 100) + "%";
    }

    void Busy(bool on)
    {
        working = on;
        Find<UIElement>("Close").Visibility = on ? Visibility.Collapsed : Visibility.Visible;
        Find<UIElement>("Meter").Visibility = on ? Visibility.Visible : Visibility.Collapsed;
    }

    void Start()
    {
        bool deleteData = Find<CheckBox>("DeleteData").IsChecked == true;
        Show("Busy");
        Find<TextBlock>("BusyTitle").Text = uninstall ? "Removing Fjord" : "Installing Fjord";
        Find<UIElement>("BusyText").Visibility = Visibility.Visible;
        Find<UIElement>("Failed").Visibility = Visibility.Collapsed;
        Busy(true);
        SetProgress("Starting…", 0);
        Action<string, double> progress = delegate (string s, double p)
        {
            Dispatcher.BeginInvoke(new Action(delegate { SetProgress(s, p); }));
        };
        string where = fjordRoot;
        Task.Run(delegate
        {
            if (uninstall) Program.Remove(where, deleteData, progress);
            else Program.Install(where, true, progress);
        }).ContinueWith(delegate (Task t)
        {
            Dispatcher.BeginInvoke(new Action(delegate
            {
                Busy(false);
                if (t.Exception != null)
                {
                    var error = t.Exception.GetBaseException();
                    Program.Log(where, (uninstall ? "Uninstall" : "Install") + " failed: " + error);
                    Find<UIElement>("BusyText").Visibility = Visibility.Collapsed;
                    Find<TextBlock>("BusyTitle").Text = uninstall ? "Fjord couldn’t be removed" : "Fjord couldn’t be installed";
                    Find<TextBlock>("Error").Text = error.Message;
                    Find<UIElement>("Failed").Visibility = Visibility.Visible;
                    Find<Button>("Retry").Focus();
                    return;
                }
                if (uninstall)
                {
                    Find<TextBlock>("RemovedText").Text = deleteData
                        ? "Everything Fjord kept on this computer is gone too."
                        : "Your bookmarks, history and passwords are kept, in case you install Fjord again.";
                    Show("Removed");
                    Find<Button>("Finish").Focus();
                }
                else
                {
                    Show("Done");
                    Find<Button>("Open").Focus();
                }
            }));
        });
    }

    // For --snapshot: shows one state, with sample progress where it's working
    public void Preview(string state)
    {
        if (state == "installing" || state == "removing")
        {
            Show("Busy");
            Find<TextBlock>("BusyTitle").Text = state == "removing" ? "Removing Fjord" : "Installing Fjord";
            Busy(true);
            SetProgress(state == "removing" ? "Deleting Fjord's files…" : "Downloading Firefox from Mozilla…", state == "removing" ? 0.62 : 0.34);
        }
        else if (state == "failed")
        {
            Show("Busy");
            Find<UIElement>("BusyText").Visibility = Visibility.Collapsed;
            Find<TextBlock>("BusyTitle").Text = "Fjord couldn’t be installed";
            Find<TextBlock>("Error").Text = "Firefox couldn't be downloaded from Mozilla. Check your internet connection, then try again.";
            Find<UIElement>("Failed").Visibility = Visibility.Visible;
        }
        else if (state == "done") Show("Done");
        else if (state == "removed")
        {
            Find<TextBlock>("RemovedText").Text = "Your bookmarks, history and passwords are kept, in case you install Fjord again.";
            Show("Removed");
        }
    }
}
