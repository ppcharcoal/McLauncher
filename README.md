# McLauncher

A simple, fast Minecraft: Java Edition launcher for Linux (Arch first), with Fabric, Modrinth and CurseForge built in.

- **Microsoft sign-in** with multiple accounts.
- **Instances** with their own mods, worlds and settings. Pick the Minecraft version and the **Fabric loader version** when you make one, or go vanilla. Give each instance its own **picture**.
- **Discover** mods, resource packs, shader packs and modpacks from **Modrinth** and **CurseForge**. Filter mods by where they run — **client-side, server-side, client & server** — or show only **libraries**. Required dependencies are installed for you; shader packs bring Iris along automatically.
- **Modpacks**: install from Modrinth (`.mrpack`) or CurseForge, drop a `.mrpack` / CurseForge `.zip` / Prism or MultiMC export onto the window to import it.
- **Export** an instance as a Modrinth modpack (`.mrpack`, mods are linked to Modrinth, everything else bundled) or as a full zip backup.
- **Browse the instance's files**: mods, resource packs, shaders, worlds, screenshots and a file browser with text preview for configs and logs. Turn mods on/off, delete, drag & drop to add, check for mod updates.
- **Gets out of the way while you play**: the launcher closes once Minecraft is up, so it uses no memory or GPU in the background, and reopens on the game's log when you quit. Logs of every session are kept.
- **Wayland/Hyprland native**, wraps the game with Feral GameMode when it is installed, downloads the right Java for every Minecraft version.

## Install on Arch Linux

```bash
# download and install the package from the latest release
curl -LO https://github.com/ppcharcoal/McLauncher/releases/download/v0.1.0/mclauncher-0.1.0-x64.pacman
sudo pacman -U ./mclauncher-0.1.0-x64.pacman

# optional: better in-game performance
sudo pacman -S --needed gamemode

# start it from your app launcher (rofi/wofi/fuzzel…) or a terminal
mclauncher
```

No Java install needed — McLauncher downloads Mojang's Java runtime for each Minecraft version.

Uninstall with `sudo pacman -R mclauncher`. Your instances live in `~/.local/share/mclauncher` (delete that folder to remove everything).

### Other distros

Use the AppImage from the release page:

```bash
chmod +x mclauncher-0.1.0-x86_64.AppImage
./mclauncher-0.1.0-x86_64.AppImage
```

### Hyprland

McLauncher runs as a native Wayland window. Bind it to a key in `~/.config/hypr/hyprland.conf` if you like:

```
bind = $mainMod, M, exec, mclauncher
```

## Build from source

```bash
sudo pacman -S --needed nodejs npm
git clone https://github.com/ppcharcoal/McLauncher && cd McLauncher/app
npm ci
npm start          # run
npm run dist       # build pacman, AppImage and tar.gz into app/dist
```

## Notes

- CurseForge works without setup through the public curse.tools proxy. Add your own key from console.curseforge.com in Settings to use the official API directly. Some CurseForge authors block third-party downloads; McLauncher lists those files with links so you can download them yourself.
- Only Fabric and vanilla are supported. Forge, NeoForge and Quilt modpacks are refused with a clear message.
