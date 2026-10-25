/*
 * Cairn GLFW Wayland shim.
 *
 * Minecraft (up to ~1.21) treats every GLFW error during window creation as fatal. On Wayland,
 * GLFW reports "The platform does not support setting the window icon" (and window position),
 * so the game dies before it opens. This tiny library is passed to LWJGL as the GLFW library
 * (-Dorg.lwjgl.glfw.libname). It links to the system libglfw.so.3, so every GLFW function
 * resolves to the real one, except the two calls Wayland can't do, which become no-ops.
 */
typedef struct GLFWwindow GLFWwindow;
typedef struct GLFWimage GLFWimage;

__attribute__((visibility("default")))
void glfwSetWindowIcon(GLFWwindow *window, int count, const GLFWimage *images) {
    (void)window; (void)count; (void)images;
}

__attribute__((visibility("default")))
void glfwSetWindowPos(GLFWwindow *window, int xpos, int ypos) {
    (void)window; (void)xpos; (void)ypos;
}
