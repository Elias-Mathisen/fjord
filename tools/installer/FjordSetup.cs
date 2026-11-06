// Fjord's Windows installer, updater and uninstaller in one program (built by tools\build-installer.ps1).
//   FjordSetup.exe               shows the install window
//   FjordSetup.exe --update      no window: updates Fjord and Firefox when a new version is out (scheduled task)
//   FjordSetup.exe --uninstall   removes Fjord (from Windows' Installed apps)
//   FjordSetup.exe --install-to <dir>   test install into <dir>, without shortcuts, task or registry entry
//   FjordSetup.exe --update-in <dir>    the same update as --update, for a test install in <dir>
//                                       (FJORD_RELEASES=<url> checks that releases list instead of GitHub's)
//   FjordSetup.exe --snapshot <png> [ready|installing|failed|done]   renders the install window to a picture, for checking the design
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

    [STAThread]
    static int Main(string[] args)
    {
        // Tls13 isn't named in older .NET Framework versions
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12 | (SecurityProtocolType)12288;
        string mode = args.Length > 0 ? args[0] : "";
        try
        {
            if (mode == "--update") return Update(DefaultRoot);
            if (mode == "--update-in" && args.Length > 1) return Update(Path.GetFullPath(args[1]));
            if (mode == "--uninstall") return Uninstall(DefaultRoot);
            if (mode == "--install-to" && args.Length > 1) { Install(Path.GetFullPath(args[1]), false, delegate (string s, double p) { Console.WriteLine("{0:0}% {1}", p * 100, s); }); return 0; }
            if (mode == "--snapshot" && args.Length > 1) { Snapshot(args[1], args.Length > 2 ? args[2] : "ready"); return 0; }
            new Application().Run(new SetupWindow());
            return 0;
        }
        catch (Exception e)
        {
            Log(DefaultRoot, "Failed: " + e);
            if (mode == "") MessageBox.Show("Fjord couldn't be installed:\n\n" + e.Message, "Fjord", MessageBoxButton.OK, MessageBoxImage.Error);
            return 1;
        }
    }

    // ---------- Install / update ----------

    public static void Install(string root, bool system, Action<string, double> progress)
    {
        string core = Path.Combine(root, "core");
        Directory.CreateDirectory(root);
        if (FjordRunning(core)) throw new Exception("Close Fjord first, then try again.");

        string setup = DownloadFirefox(root, progress);
        progress("Unpacking…", 0.5);
        ReplaceCore(root, setup);
        progress("Adding Fjord…", 0.54);
        ApplyPayload(core);
        Directory.CreateDirectory(Path.Combine(root, "profile"));
        ClearStartupCache(root);

        if (system)
        {
            progress("Finishing…", 0.97);
            string self = Path.Combine(root, "FjordSetup.exe");
            if (!string.Equals(Assembly.GetExecutingAssembly().Location, self, StringComparison.OrdinalIgnoreCase))
                File.Copy(Assembly.GetExecutingAssembly().Location, self, true);
            CreateShortcuts(root);
            RegisterUninstall(root);
            // Firefox's pulsing placeholder window, off before the first start too (Fjord.cfg turns it off after that)
            using (var key = Registry.CurrentUser.CreateSubKey(SkeletonKey))
                key.SetValue(Path.Combine(core, "firefox.exe") + "|Enabled", 0, RegistryValueKind.DWord);
            // Every 3 hours, as this user; the updater has no window, so nothing flashes on screen
            Run("schtasks.exe", string.Format("/Create /F /SC HOURLY /MO 3 /TN \"{0}\" /TR \"\\\"{1}\\\" --update\"", TaskName, self));
        }
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

    static int Uninstall(string root)
    {
        string core = Path.Combine(root, "core");
        if (FjordRunning(core))
        {
            MessageBox.Show("Close Fjord first, then uninstall it again.", "Fjord", MessageBoxButton.OK, MessageBoxImage.Information);
            return 1;
        }
        var answer = MessageBox.Show("Uninstall Fjord?\n\nChoose Yes to also delete your bookmarks, history, passwords and settings, or No to keep them in case you install Fjord again.",
            "Uninstall Fjord", MessageBoxButton.YesNoCancel, MessageBoxImage.Question, MessageBoxResult.No);
        if (answer == MessageBoxResult.Cancel) return 1;

        Run("schtasks.exe", string.Format("/Delete /F /TN \"{0}\"", TaskName));
        foreach (string lnk in ShortcutPaths()) if (File.Exists(lnk)) File.Delete(lnk);
        // The one Firefox itself made on first start in versions before Fjord turned that off (Fjord.cfg)
        string privateLnk = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Fjord Private Browsing.lnk");
        if (File.Exists(privateLnk)) File.Delete(privateLnk);
        Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false);
        using (var key = Registry.CurrentUser.OpenSubKey(SkeletonKey, true))
            if (key != null)
                foreach (string name in key.GetValueNames())
                    if (name.StartsWith(Path.Combine(core, "firefox.exe") + "|", StringComparison.OrdinalIgnoreCase)) key.DeleteValue(name);
        // This program is running from the folder, so a short-lived cmd deletes it after we exit
        string remove = answer == MessageBoxResult.Yes
            ? "rmdir /s /q " + Quote(root)
            : "rmdir /s /q " + Quote(core) + " & del /q " + Quote(Path.Combine(root, "FjordSetup.exe"));
        string cmd = "/c ping 127.0.0.1 -n 3 >nul & " + remove;
        Process.Start(new ProcessStartInfo("cmd.exe", cmd) { CreateNoWindow = true, UseShellExecute = false });
        MessageBox.Show("Fjord has been uninstalled.", "Fjord", MessageBoxButton.OK, MessageBoxImage.Information);
        return 0;
    }

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

    // Downloads Mozilla's installer and refuses anything not validly signed by Mozilla
    static string DownloadFirefox(string root, Action<string, double> progress)
    {
        string path = Path.Combine(Path.GetTempPath(), "fjord-firefox-" + Guid.NewGuid().ToString("N") + ".exe");
        using (var web = new WebClient())
        {
            var done = new TaskCompletionSource<bool>();
            web.DownloadProgressChanged += delegate (object s, DownloadProgressChangedEventArgs e)
            {
                progress("Downloading Firefox from Mozilla…", 0.05 + 0.4 * e.ProgressPercentage / 100.0);
            };
            web.DownloadFileCompleted += delegate (object s, System.ComponentModel.AsyncCompletedEventArgs e)
            {
                if (e.Error != null) done.SetException(e.Error); else done.SetResult(true);
            };
            progress("Downloading Firefox from Mozilla…", 0.05);
            web.DownloadFileAsync(new Uri(FirefoxUrl), path);
            done.Task.Wait();
        }
        progress("Checking Mozilla's signature…", 0.47);
        if (!SignedByMozilla(path))
        {
            File.Delete(path);
            throw new Exception("The downloaded Firefox isn't validly signed by Mozilla, so it wasn't installed.");
        }
        return path;
    }

    // Extracts next to the old copy and swaps only once that worked; the profile folder is never touched
    static void ReplaceCore(string root, string setup)
    {
        string stage = Path.Combine(root, "staging");
        if (Directory.Exists(stage)) Directory.Delete(stage, true);
        // Unpacked with Windows' own tar (it reads Mozilla's 7-Zip installer): running the installer itself
        // would pop up Mozilla's "Firefox Installer" window
        Directory.CreateDirectory(stage);
        var p = Process.Start(new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "tar.exe"),
            "-xf " + Quote(setup) + " -C " + Quote(stage) + " core") { UseShellExecute = false, CreateNoWindow = true });
        p.WaitForExit();
        File.Delete(setup);
        string fresh = Path.Combine(stage, "core");
        if (!File.Exists(Path.Combine(fresh, "firefox.exe"))) throw new Exception("Firefox couldn't be unpacked.");
        string core = Path.Combine(root, "core");
        RenameOldFolder(core);
        // The new-tab photos were downloaded separately; carried over so an update doesn't fetch them again
        string photos = Path.Combine(core, "fjord", "photos");
        if (Directory.Exists(photos))
        {
            Directory.CreateDirectory(Path.Combine(fresh, "fjord"));
            Directory.Move(photos, Path.Combine(fresh, "fjord", "photos"));
        }
        if (Directory.Exists(core))
        {
            string old = core + "-old";
            if (Directory.Exists(old)) Directory.Delete(old, true);
            Directory.Move(core, old);
            Directory.Move(fresh, core);
            Directory.Delete(old, true);
        }
        else Directory.Move(fresh, core);
        Directory.Delete(stage, true);
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

    static void Log(string root, string line)
    {
        try
        {
            Directory.CreateDirectory(root);
            File.AppendAllText(Path.Combine(root, "update.log"), DateTime.Now.ToString("u") + " " + line + Environment.NewLine);
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
        var w = new SetupWindow();
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

// The install window: the cabin illustration on the left; on the right Install, then the three steps as they happen,
// then Open Fjord
class SetupWindow : Window
{
    const string Xaml = @"
<Border xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation' xmlns:x='http://schemas.microsoft.com/winfx/2006/xaml'
        CornerRadius='18' Background='#F5F5F6' BorderBrush='#E2E2E5' BorderThickness='1'>
  <Border.Resources>
    <Style x:Key='Primary' TargetType='Button'>
      <Setter Property='Foreground' Value='#FFFFFF'/>
      <Setter Property='FontSize' Value='15'/>
      <Setter Property='FontWeight' Value='SemiBold'/>
      <Setter Property='Cursor' Value='Hand'/>
      <Setter Property='Template'>
        <Setter.Value>
          <ControlTemplate TargetType='Button'>
            <Border x:Name='b' Background='#1D1D1F' CornerRadius='12' Padding='26,12' BorderBrush='Transparent' BorderThickness='2'>
              <ContentPresenter HorizontalAlignment='Center' VerticalAlignment='Center'/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property='IsMouseOver' Value='True'><Setter TargetName='b' Property='Background' Value='#000000'/></Trigger>
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
            <Border x:Name='b' Background='Transparent' CornerRadius='10' Padding='12,12' BorderBrush='Transparent' BorderThickness='2'>
              <ContentPresenter HorizontalAlignment='Center' VerticalAlignment='Center'/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property='IsMouseOver' Value='True'><Setter Property='Foreground' Value='#1D1D1F'/></Trigger>
              <Trigger Property='IsKeyboardFocused' Value='True'><Setter TargetName='b' Property='BorderBrush' Value='#8AB4F8'/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key='Quiet' TargetType='Button'>
      <Setter Property='Foreground' Value='#6E6E73'/>
      <Setter Property='FontSize' Value='16'/>
      <Setter Property='Cursor' Value='Hand'/>
      <Setter Property='Template'>
        <Setter.Value>
          <ControlTemplate TargetType='Button'>
            <Border x:Name='b' Background='Transparent' CornerRadius='8' Width='34' Height='34'>
              <ContentPresenter HorizontalAlignment='Center' VerticalAlignment='Center'/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property='IsMouseOver' Value='True'><Setter TargetName='b' Property='Background' Value='#14000000'/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key='Title' TargetType='TextBlock'>
      <Setter Property='FontSize' Value='24'/>
      <Setter Property='FontWeight' Value='SemiBold'/>
      <Setter Property='Foreground' Value='#1D1D1F'/>
      <Setter Property='LineHeight' Value='29'/>
    </Style>
    <Style x:Key='Body' TargetType='TextBlock'>
      <Setter Property='FontSize' Value='13'/>
      <Setter Property='Foreground' Value='#6E6E73'/>
      <Setter Property='LineHeight' Value='20'/>
      <Setter Property='TextWrapping' Value='Wrap'/>
      <Setter Property='Margin' Value='0,12,0,0'/>
    </Style>
  </Border.Resources>
  <Grid>
    <Grid.ColumnDefinitions><ColumnDefinition Width='290'/><ColumnDefinition Width='*'/></Grid.ColumnDefinitions>
    <!-- Drawn a little larger than its slot and clipped: smooth scaling leaves a bright fringe at an image's own edges -->
    <Border Margin='6,6,0,6' ClipToBounds='True'>
      <Image x:Name='Art' Stretch='UniformToFill' Margin='-4' RenderOptions.BitmapScalingMode='HighQuality'/>
    </Border>
    <Button x:Name='Close' Grid.Column='1' Style='{StaticResource Quiet}' Content='✕' HorizontalAlignment='Right' VerticalAlignment='Top' Margin='0,12,12,0' ToolTip='Close'/>
    <Grid Grid.Column='1' Margin='28,40,40,40'>
      <StackPanel Orientation='Horizontal' VerticalAlignment='Top'>
        <Image x:Name='Logo' Width='32' Height='32' RenderOptions.BitmapScalingMode='HighQuality'/>
        <TextBlock Text='Fjord' FontSize='18' FontWeight='SemiBold' Foreground='#1D1D1F' VerticalAlignment='Center' Margin='10,0,0,0'/>
      </StackPanel>

      <StackPanel x:Name='Ready' VerticalAlignment='Bottom'>
        <TextBlock Style='{StaticResource Title}'>A browser that&#x2019;s<LineBreak/>on your side.</TextBlock>
        <TextBlock Style='{StaticResource Body}' Text='Ads and trackers are blocked from the first page you open. Installs for your account only, with no admin password needed, adds Fjord to the Start menu and desktop, and keeps it up to date in the background.'/>
        <Button x:Name='Install' Style='{StaticResource Primary}' Content='Install' HorizontalAlignment='Left' Margin='0,22,0,0'/>
      </StackPanel>

      <StackPanel x:Name='Busy' VerticalAlignment='Bottom' Visibility='Collapsed'>
        <TextBlock Style='{StaticResource Title}' Text='Installing Fjord'/>
        <StackPanel Margin='0,16,0,6'>
          <Grid Margin='0,0,0,12'>
            <Ellipse x:Name='Mark0' Width='20' Height='20' HorizontalAlignment='Left'/>
            <Path x:Name='Tick0' Data='M5.5,10.5 L8.5,13.5 L14.5,7' Stroke='White' StrokeThickness='2' StrokeStartLineCap='Round' StrokeEndLineCap='Round' StrokeLineJoin='Round' Width='20' Height='20' HorizontalAlignment='Left'/>
            <TextBlock x:Name='Step0' Text='Download Firefox from Mozilla' FontSize='13' VerticalAlignment='Center' Margin='32,0,0,0'/>
          </Grid>
          <Grid Margin='0,0,0,12'>
            <Ellipse x:Name='Mark1' Width='20' Height='20' HorizontalAlignment='Left'/>
            <Path x:Name='Tick1' Data='M5.5,10.5 L8.5,13.5 L14.5,7' Stroke='White' StrokeThickness='2' StrokeStartLineCap='Round' StrokeEndLineCap='Round' StrokeLineJoin='Round' Width='20' Height='20' HorizontalAlignment='Left'/>
            <TextBlock x:Name='Step1' Text='Check Mozilla&#x2019;s signature' FontSize='13' VerticalAlignment='Center' Margin='32,0,0,0'/>
          </Grid>
          <Grid>
            <Ellipse x:Name='Mark2' Width='20' Height='20' HorizontalAlignment='Left'/>
            <Path x:Name='Tick2' Data='M5.5,10.5 L8.5,13.5 L14.5,7' Stroke='White' StrokeThickness='2' StrokeStartLineCap='Round' StrokeEndLineCap='Round' StrokeLineJoin='Round' Width='20' Height='20' HorizontalAlignment='Left'/>
            <TextBlock x:Name='Step2' Text='Add Fjord' FontSize='13' VerticalAlignment='Center' Margin='32,0,0,0'/>
          </Grid>
        </StackPanel>
        <StackPanel x:Name='Meter'>
          <Grid Height='4' Margin='0,6,0,0'>
            <Grid.ColumnDefinitions><ColumnDefinition x:Name='Filled' Width='0*'/><ColumnDefinition x:Name='Rest' Width='1*'/></Grid.ColumnDefinitions>
            <Border Grid.ColumnSpan='2' CornerRadius='2' Background='#E2E2E5'/>
            <Border CornerRadius='2' Background='#1D1D1F'/>
          </Grid>
          <Grid Margin='0,8,0,0'>
            <TextBlock x:Name='Status' FontSize='12' Foreground='#6E6E73' TextTrimming='CharacterEllipsis' Margin='0,0,48,0'/>
            <TextBlock x:Name='Percent' FontSize='12' Foreground='#6E6E73' HorizontalAlignment='Right'/>
          </Grid>
        </StackPanel>
        <StackPanel x:Name='Failed' Visibility='Collapsed'>
          <TextBlock x:Name='Error' Style='{StaticResource Body}' Foreground='#B3261E'/>
          <Button x:Name='Retry' Style='{StaticResource Primary}' Content='Try again' HorizontalAlignment='Left' Margin='0,16,0,0'/>
        </StackPanel>
      </StackPanel>

      <StackPanel x:Name='Done' VerticalAlignment='Bottom' Visibility='Collapsed'>
        <TextBlock Style='{StaticResource Title}' Text='Fjord is ready.'/>
        <TextBlock Style='{StaticResource Body}' Text='It&#x2019;s in the Start menu and on your desktop, and keeps itself up to date.'/>
        <StackPanel Orientation='Horizontal' Margin='0,22,0,0'>
          <Button x:Name='Open' Style='{StaticResource Primary}' Content='Open Fjord'/>
          <Button x:Name='Later' Style='{StaticResource Link}' Content='Close' Margin='8,0,0,0' VerticalAlignment='Center'/>
        </StackPanel>
      </StackPanel>
    </Grid>
  </Grid>
</Border>";

    static readonly Brush Ink = Hex("#1D1D1F"), Muted = Hex("#6E6E73"), Faint = Hex("#C7C7CC");
    static Brush Hex(string color) { return new SolidColorBrush((Color)ColorConverter.ConvertFromString(color)); }

    readonly Border root;
    T Find<T>(string name) where T : class { return (T)root.FindName(name); }

    public SetupWindow()
    {
        Title = "Fjord Setup";
        Width = 640;
        Height = 420;
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        ResizeMode = ResizeMode.NoResize;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        FontFamily = new FontFamily("Segoe UI Variable Display, Segoe UI");
        Icon = Program.Picture("logo.png");
        root = (Border)XamlReader.Parse(Xaml);
        Content = root;
        Find<Image>("Art").Source = Program.Picture("cabin.jpg");
        Find<Image>("Logo").Source = Program.Picture("logo.png");
        Find<Button>("Close").Click += delegate { Close(); };
        Find<Button>("Later").Click += delegate { Close(); };
        Find<Button>("Install").Click += delegate { Start(); };
        Find<Button>("Retry").Click += delegate { Start(); };
        Find<Button>("Open").Click += delegate { Program.Launch(Program.Root); Close(); };
        MouseLeftButtonDown += delegate (object s, MouseButtonEventArgs e) { if (e.ButtonState == MouseButtonState.Pressed) DragMove(); };
        Loaded += delegate { Find<Button>("Install").Focus(); };
    }

    void Show(string panel)
    {
        foreach (var name in new[] { "Ready", "Busy", "Done" })
            Find<UIElement>(name).Visibility = name == panel ? Visibility.Visible : Visibility.Collapsed;
    }

    // Program.Install reports the Firefox download up to 0.45, the signature check and unpacking up to 0.5, then adding
    // Fjord from 0.54 (Fjord downloads the new-tab photos itself, after it starts)
    static int StepFor(double p) { return p < 0.47 ? 0 : p < 0.54 ? 1 : 2; }

    void SetProgress(string status, double p)
    {
        int step = StepFor(p);
        for (int i = 0; i < 3; i++)
        {
            var mark = Find<System.Windows.Shapes.Ellipse>("Mark" + i);
            bool done = i < step, now = i == step;
            mark.Fill = done ? Ink : Brushes.Transparent;
            mark.Stroke = done ? null : now ? Ink : Faint;
            mark.StrokeThickness = now ? 2 : 1.5;
            Find<UIElement>("Tick" + i).Visibility = done ? Visibility.Visible : Visibility.Collapsed;
            var label = Find<TextBlock>("Step" + i);
            label.FontWeight = now ? FontWeights.SemiBold : FontWeights.Normal;
            label.Foreground = i > step ? Muted : Ink;
        }
        p = Math.Max(0, Math.Min(1, p));
        Find<ColumnDefinition>("Filled").Width = new GridLength(p, GridUnitType.Star);
        Find<ColumnDefinition>("Rest").Width = new GridLength(1 - p, GridUnitType.Star);
        Find<TextBlock>("Status").Text = status;
        Find<TextBlock>("Percent").Text = (int)Math.Round(p * 100) + "%";
    }

    void Start()
    {
        Show("Busy");
        Find<UIElement>("Meter").Visibility = Visibility.Visible;
        Find<UIElement>("Failed").Visibility = Visibility.Collapsed;
        SetProgress("Starting…", 0);
        Action<string, double> progress = delegate (string s, double p)
        {
            Dispatcher.BeginInvoke(new Action(delegate { SetProgress(s, p); }));
        };
        Task.Run(delegate { Program.Install(Program.Root, true, progress); }).ContinueWith(delegate (Task t)
        {
            Dispatcher.BeginInvoke(new Action(delegate
            {
                if (t.Exception != null)
                {
                    Find<UIElement>("Meter").Visibility = Visibility.Collapsed;
                    Find<TextBlock>("Error").Text = "Couldn't install: " + t.Exception.GetBaseException().Message;
                    Find<UIElement>("Failed").Visibility = Visibility.Visible;
                    Find<Button>("Retry").Focus();
                    return;
                }
                Show("Done");
                Find<Button>("Open").Focus();
            }));
        });
    }

    // For --snapshot: shows one state, with sample progress for "installing"
    public void Preview(string state)
    {
        if (state == "installing") { Show("Busy"); SetProgress("Checking Mozilla’s signature…", 0.47); }
        else if (state == "failed")
        {
            Show("Busy"); SetProgress("Downloading Firefox from Mozilla…", 0.2);
            Find<UIElement>("Meter").Visibility = Visibility.Collapsed;
            Find<TextBlock>("Error").Text = "Couldn't install: Unable to connect to the remote server";
            Find<UIElement>("Failed").Visibility = Visibility.Visible;
        }
        else if (state == "done") Show("Done");
        else Show("Ready");
    }
}
