Cairn 0.6.0 (formerly McLauncher)

- **New name and icon**: McLauncher is now **Cairn**, a stack of stones that marks the trail. On Arch the new `cairn` package replaces `mclauncher` automatically; your instances, worlds and settings stay where they are. On Windows the installer upgrades the old app in place.
- **Styles**: Settings → Appearance now offers four styles instead of a font list, each changing the whole look and typeface. Minimal (the familiar calm look, Onest), Modern Glass (frosted panels over a soft glow, Inter), Frutiger Aero (glossy sky-blue glass and bubbles, Nunito) and Dark Matter (deep space with a neon edge, Space Grotesk). The accent color picker works with all of them.
- **Native Wayland is now automatic**: on a Wayland session with GLFW 3.4 installed, games open as native Wayland windows, which avoids the XWayland crash (SIGSEGV in libX11) on Hyprland with NVIDIA. Set it to Always or Never in Settings or per instance.

Install: see the README for Arch Linux and Windows instructions.
