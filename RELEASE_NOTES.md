McLauncher 0.7.1

- **Native Wayland with Forge**: Forge 1.20.1 packs (for example Liminal Industries) crashed on start with "GLFW error before init: Wayland: The platform does not provide the window position". Forge's early loading window asks for a window position, which Wayland doesn't have. McLauncher's GLFW shim now answers that request and hides the harmless "not available on Wayland" errors from the game, while real errors still come through.

Install: see the README for Arch Linux and Windows instructions.
