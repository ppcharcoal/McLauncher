McLauncher 0.5.0

- **Pick the Java for each instance**: Settings → Java lets you choose Automatic, a Java version McLauncher downloads for you (8, 17, 21, 25…), any Java found on your computer, or a custom path (with a Test button). Instances also get their own environment variables.
- **Prism Launcher / MultiMC packs with custom components**: packs such as GT New Horizons (Java 17+) that replace LWJGL and the launch setup with their own patches now import and run as the pack intends. Their component list shows in the instance settings, and a compatible Java (17–25 for GTNH) is picked automatically.
- **Prism pictures**: imported Prism/MultiMC packs keep their icon (e.g. GTNH).
- **Native Wayland works on older Minecraft**: McLauncher now includes a small GLFW shim, so 1.20.x no longer fails with "GLFW error 65548: The platform does not support setting the window icon".
- **NVIDIA crash fix (Linux)**: NVIDIA threaded optimizations are turned off for Minecraft (as Sodium recommends). This addresses the SIGSEGV in libX11 `XCheckTypedWindowEvent` under XWayland. It can be turned off in Settings.
- **App icon on Linux**: the package now installs the icon in all standard sizes, so it shows in Hyprland, launchers and taskbars.
- Fixed the white square where two scrollbars meet in the config editor.

Install: see the README for Arch Linux and Windows instructions.
