/*
 * McLauncher GLFW Wayland shim.
 *
 * Minecraft (up to ~1.21) and Forge's early loading window treat every GLFW error during start-up
 * as fatal. On Wayland, GLFW reports GLFW_FEATURE_UNAVAILABLE (0x1000C / 65548) for things Wayland
 * simply doesn't have: window icons and window positions. The game then dies before it opens.
 *
 * This library is passed to LWJGL as the GLFW library (-Dorg.lwjgl.glfw.libname). It links to the
 * system libglfw.so.3, so every GLFW function resolves to the real one, except:
 *   - glfwSetWindowIcon / glfwSetWindowPos: no-ops
 *   - glfwGetWindowPos: reports 0,0
 *   - glfwSetErrorCallback / glfwGetError: GLFW_FEATURE_UNAVAILABLE errors are dropped
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stddef.h>

#define GLFW_NO_ERROR 0
#define GLFW_FEATURE_UNAVAILABLE 0x0001000C

typedef struct GLFWwindow GLFWwindow;
typedef struct GLFWimage GLFWimage;
typedef void (*GLFWerrorfun)(int error_code, const char *description);

#define EXPORT __attribute__((visibility("default")))

static void *real_glfw(void) {
    static void *h = NULL;
    if (!h) h = dlopen("libglfw.so.3", RTLD_NOW | RTLD_NOLOAD);
    if (!h) h = dlopen("libglfw.so.3", RTLD_NOW);
    return h;
}
static void *real(const char *name) {
    void *h = real_glfw();
    return h ? dlsym(h, name) : NULL;
}

EXPORT void glfwSetWindowIcon(GLFWwindow *window, int count, const GLFWimage *images) {
    (void)window; (void)count; (void)images;
}

EXPORT void glfwSetWindowPos(GLFWwindow *window, int xpos, int ypos) {
    (void)window; (void)xpos; (void)ypos;
}

EXPORT void glfwGetWindowPos(GLFWwindow *window, int *xpos, int *ypos) {
    (void)window;
    if (xpos) *xpos = 0;
    if (ypos) *ypos = 0;
}

static GLFWerrorfun user_callback = NULL;

static void filtered_callback(int code, const char *description) {
    if (code == GLFW_FEATURE_UNAVAILABLE) return;
    if (user_callback) user_callback(code, description);
}

EXPORT GLFWerrorfun glfwSetErrorCallback(GLFWerrorfun callback) {
    typedef GLFWerrorfun (*set_fn)(GLFWerrorfun);
    static set_fn set_real = NULL;
    if (!set_real) set_real = (set_fn)real("glfwSetErrorCallback");
    GLFWerrorfun previous = user_callback;
    user_callback = callback;
    if (set_real) set_real(callback ? filtered_callback : NULL);
    return previous;
}

EXPORT int glfwGetError(const char **description) {
    typedef int (*get_fn)(const char **);
    static get_fn get_real = NULL;
    if (!get_real) get_real = (get_fn)real("glfwGetError");
    if (!get_real) { if (description) *description = NULL; return GLFW_NO_ERROR; }
    int code = get_real(description);
    if (code == GLFW_FEATURE_UNAVAILABLE) {
        if (description) *description = NULL;
        return GLFW_NO_ERROR;
    }
    return code;
}
