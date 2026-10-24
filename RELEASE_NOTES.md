McLauncher 0.4.0

- **Edit config files in the launcher**: in an instance's Files tab, pick any config (JSON, TOML, properties, txt…) to edit it, then Save (Ctrl+S). JSON is checked as you type, unsaved changes are guarded, and logs stay read-only.
- **Font and text size**: choose Onest, Inter, Figtree, Nunito, your system font, or any installed font; plus four text sizes. Fonts are now loaded in a way that also works where the bundled font previously failed to load (some Arch setups showed a serif fallback).
- **Import anything**: one Import button for Modrinth `.mrpack`, CurseForge zips (Fabric, Forge, NeoForge), Prism Launcher/MultiMC exports and instance folders, McLauncher backups — also when the pack sits inside an extra folder in the zip. Any other zip or folder with mods and configs can be imported too: McLauncher guesses the loader and Minecraft version from the mods and lets you confirm them.
- **Modpack file checks**: McLauncher remembers every file a modpack needs. Files that fail to download or that CurseForge won't hand out are fetched from Modrinth when the same file exists there. Anything still missing is listed with its download page and target folder — drop the downloaded files on the dialog, or let McLauncher pick them up from your Downloads folder. Play checks this first, and "Check modpack files" is in each instance's menu.
- **Native Wayland option (Linux)**: run Minecraft as a native Wayland window through the system GLFW. This avoids XWayland crashes such as SIGSEGV in libX11 `XCheckTypedWindowEvent` on Hyprland. The crash screen offers it in one click.

Install: see the README for Arch Linux and Windows instructions.
