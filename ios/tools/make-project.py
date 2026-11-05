#!/usr/bin/env python3
"""Writes ios/Fjord.xcodeproj from the files in ios/Fjord (every .swift file, everything in Resources/, the asset
catalog). Run by ios/build.sh, so a new source file is picked up without opening Xcode."""
import hashlib
import os
import re

IOS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(IOS, "Fjord")
TEAM = "LT7NW2Y8WH"  # the Apple Development team on the build Mac, for running on a real iPhone
BUNDLE_ID = "io.github.eliasmathisen.fjord"


def uid(name):
    return hashlib.md5(name.encode()).hexdigest()[:24].upper()


def q(v):
    return v if re.fullmatch(r"[A-Za-z0-9_./]+", v) else '"' + v.replace("\\", "\\\\").replace('"', '\\"') + '"'


def ser(v, indent=1):
    pad = "\t" * indent
    if isinstance(v, dict):
        return "{\n" + "".join(f"{pad}{q(k)} = {ser(x, indent + 1)};\n" for k, x in v.items()) + "\t" * (indent - 1) + "}"
    if isinstance(v, list):
        return "(\n" + "".join(f"{pad}{ser(x, indent + 1)},\n" for x in v) + "\t" * (indent - 1) + ")"
    return q(str(v))


FILE_TYPES = {".swift": "sourcecode.swift", ".json": "text.json", ".jpg": "image.jpeg", ".png": "image.png", ".plist": "text.plist.xml"}
sources = sorted(f for f in os.listdir(APP) if f.endswith(".swift"))
resources = sorted(f for f in os.listdir(os.path.join(APP, "Resources")) if not f.startswith("."))
objects = {}


def ref(name, path, kind, tree="<group>"):
    objects[uid("ref:" + name)] = {"isa": "PBXFileReference", "lastKnownFileType": kind, "path": path, "sourceTree": tree}
    return uid("ref:" + name)


def build_file(name, file_ref):
    objects[uid("build:" + name)] = {"isa": "PBXBuildFile", "fileRef": file_ref}
    return uid("build:" + name)


source_refs = [ref(f, f, FILE_TYPES[".swift"]) for f in sources]
resource_refs = [ref("res:" + f, f, FILE_TYPES.get(os.path.splitext(f)[1], "file")) for f in resources]
assets_ref = ref("Assets.xcassets", "Assets.xcassets", "folder.assetcatalog")
plist_ref = ref("Info.plist", "Info.plist", "text.plist.xml")
product = uid("product")
objects[product] = {"isa": "PBXFileReference", "explicitFileType": "wrapper.application", "includeInIndex": "0",
                    "path": "Fjord.app", "sourceTree": "BUILT_PRODUCTS_DIR"}

res_group, app_group, products_group, main_group = uid("g:res"), uid("g:app"), uid("g:products"), uid("g:main")
objects[res_group] = {"isa": "PBXGroup", "children": resource_refs, "path": "Resources", "sourceTree": "<group>"}
objects[app_group] = {"isa": "PBXGroup", "children": source_refs + [assets_ref, plist_ref, res_group], "path": "Fjord", "sourceTree": "<group>"}
objects[products_group] = {"isa": "PBXGroup", "children": [product], "name": "Products", "sourceTree": "<group>"}
objects[main_group] = {"isa": "PBXGroup", "children": [app_group, products_group], "sourceTree": "<group>"}

sources_phase, resources_phase, frameworks_phase = uid("p:sources"), uid("p:resources"), uid("p:frameworks")
objects[sources_phase] = {"isa": "PBXSourcesBuildPhase", "buildActionMask": "2147483647",
                          "files": [build_file(f, r) for f, r in zip(sources, source_refs)], "runOnlyForDeploymentPostprocessing": "0"}
objects[resources_phase] = {"isa": "PBXResourcesBuildPhase", "buildActionMask": "2147483647",
                            "files": [build_file("res:" + f, r) for f, r in zip(resources, resource_refs)] + [build_file("assets", assets_ref)],
                            "runOnlyForDeploymentPostprocessing": "0"}
objects[frameworks_phase] = {"isa": "PBXFrameworksBuildPhase", "buildActionMask": "2147483647", "files": [], "runOnlyForDeploymentPostprocessing": "0"}

common = {"ALWAYS_SEARCH_USER_PATHS": "NO", "CLANG_ENABLE_MODULES": "YES", "CLANG_ENABLE_OBJC_ARC": "YES",
          "ENABLE_STRICT_OBJC_MSGSEND": "YES", "GCC_NO_COMMON_BLOCKS": "YES", "IPHONEOS_DEPLOYMENT_TARGET": "17.0",
          "SDKROOT": "iphoneos", "SWIFT_VERSION": "5.0", "ENABLE_USER_SCRIPT_SANDBOXING": "YES"}
project_configs = {
    "Debug": {**common, "DEBUG_INFORMATION_FORMAT": "dwarf", "ENABLE_TESTABILITY": "YES", "GCC_OPTIMIZATION_LEVEL": "0",
              "GCC_PREPROCESSOR_DEFINITIONS": ["DEBUG=1", "$(inherited)"], "ONLY_ACTIVE_ARCH": "YES",
              "SWIFT_ACTIVE_COMPILATION_CONDITIONS": "DEBUG $(inherited)", "SWIFT_OPTIMIZATION_LEVEL": "-Onone"},
    "Release": {**common, "DEBUG_INFORMATION_FORMAT": "dwarf-with-dsym", "SWIFT_COMPILATION_MODE": "wholemodule",
                "SWIFT_OPTIMIZATION_LEVEL": "-O", "VALIDATE_PRODUCT": "YES"},
}
target_settings = {
    "ASSETCATALOG_COMPILER_APPICON_NAME": "AppIcon", "CODE_SIGN_STYLE": "Automatic", "DEVELOPMENT_TEAM": TEAM,
    "CURRENT_PROJECT_VERSION": "1", "MARKETING_VERSION": "0.1", "GENERATE_INFOPLIST_FILE": "YES", "INFOPLIST_FILE": "Fjord/Info.plist",
    "INFOPLIST_KEY_CFBundleDisplayName": "Fjord", "INFOPLIST_KEY_LSApplicationCategoryType": "public.app-category.utilities",
    "INFOPLIST_KEY_NSFaceIDUsageDescription": "Fjord uses Face ID to unlock when App lock is on.",
    "INFOPLIST_KEY_UIApplicationSceneManifest_Generation": "YES", "INFOPLIST_KEY_UILaunchScreen_Generation": "YES",
    "INFOPLIST_KEY_UISupportedInterfaceOrientations_iPhone": "UIInterfaceOrientationPortrait UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight",
    "INFOPLIST_KEY_UISupportedInterfaceOrientations_iPad": "UIInterfaceOrientationPortrait UIInterfaceOrientationPortraitUpsideDown UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight",
    "LD_RUNPATH_SEARCH_PATHS": ["$(inherited)", "@executable_path/Frameworks"], "PRODUCT_BUNDLE_IDENTIFIER": BUNDLE_ID,
    "PRODUCT_NAME": "$(TARGET_NAME)", "SWIFT_EMIT_LOC_STRINGS": "NO", "TARGETED_DEVICE_FAMILY": "1,2",
}


def config_list(prefix, configs):
    ids = []
    for name, settings in configs.items():
        objects[uid(prefix + name)] = {"isa": "XCBuildConfiguration", "buildSettings": settings, "name": name}
        ids.append(uid(prefix + name))
    objects[uid(prefix + "list")] = {"isa": "XCConfigurationList", "buildConfigurations": ids,
                                     "defaultConfigurationIsVisible": "0", "defaultConfigurationName": "Release"}
    return uid(prefix + "list")


target = uid("target")
objects[target] = {"isa": "PBXNativeTarget", "buildConfigurationList": config_list("t:", {"Debug": target_settings, "Release": target_settings}),
                   "buildPhases": [sources_phase, frameworks_phase, resources_phase], "buildRules": [], "dependencies": [],
                   "name": "Fjord", "productName": "Fjord", "productReference": product,
                   "productType": "com.apple.product-type.application"}
project = uid("project")
objects[project] = {"isa": "PBXProject", "attributes": {"BuildIndependentTargetsInParallel": "1", "LastSwiftUpdateCheck": "2700",
                                                         "LastUpgradeCheck": "2700"},
                    "buildConfigurationList": config_list("p:", project_configs), "compatibilityVersion": "Xcode 14.0",
                    "developmentRegion": "en", "hasScannedForEncodings": "0", "knownRegions": ["en", "Base"],
                    "mainGroup": main_group, "productRefGroup": products_group, "projectDirPath": "", "projectRoot": "", "targets": [target]}

os.makedirs(os.path.join(IOS, "Fjord.xcodeproj"), exist_ok=True)
with open(os.path.join(IOS, "Fjord.xcodeproj", "project.pbxproj"), "w") as f:
    f.write("// !$*UTF8*$!\n" + ser({"archiveVersion": "1", "classes": {}, "objectVersion": "60", "objects": objects, "rootObject": project}, 1) + "\n")
print(f"Fjord.xcodeproj: {len(sources)} sources, {len(resources)} resources")
