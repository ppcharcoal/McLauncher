#!/bin/sh
# Builds native/linux-x64/libmcl-glfw-wayland.so. Links against a stub so the build machine
# needs no GLFW; at runtime the system libglfw.so.3 is loaded as a dependency.
set -e
cd "$(dirname "$0")"
tmp=$(mktemp -d)
printf "void glfwInit(void){}\nint glfwGetError(const char**d){return 0;}\nvoid* glfwSetErrorCallback(void*c){return 0;}\n" > "$tmp/stub.c"
gcc -shared -fPIC -Wl,-soname,libglfw.so.3 -o "$tmp/libglfw.so.3" "$tmp/stub.c"
mkdir -p linux-x64
gcc -shared -fPIC -O2 -fvisibility=hidden -o linux-x64/libmcl-glfw-wayland.so glfw-wayland-shim.c -Wl,--no-as-needed "$tmp/libglfw.so.3" -ldl
rm -rf "$tmp"
readelf -d linux-x64/libmcl-glfw-wayland.so | grep NEEDED
