#define _GNU_SOURCE

#include <errno.h>
#include <stdarg.h>

/*
 * Some Android 12 vendor seccomp policies kill processes that invoke
 * close_range(2), instead of returning ENOSYS as older kernels normally do.
 * Bun probes close_range through libc's variadic syscall() wrapper during
 * startup, so interpose that one probe and let Bun use its portable fallback.
 */
#define ANDROID_ARM64_NR_CLOSE_RANGE 436L

static long raw_syscall(long number, long a1, long a2, long a3, long a4, long a5, long a6) {
#if defined(__aarch64__)
    register long x0 __asm__("x0") = a1;
    register long x1 __asm__("x1") = a2;
    register long x2 __asm__("x2") = a3;
    register long x3 __asm__("x3") = a4;
    register long x4 __asm__("x4") = a5;
    register long x5 __asm__("x5") = a6;
    register long x8 __asm__("x8") = number;
    __asm__ volatile("svc 0"
                     : "+r"(x0)
                     : "r"(x1), "r"(x2), "r"(x3), "r"(x4), "r"(x5), "r"(x8)
                     : "memory", "cc");
    return x0;
#else
#error "The Bun Android seccomp compatibility layer is ARM64-only"
#endif
}

long syscall(long number, ...) {
    if (number == ANDROID_ARM64_NR_CLOSE_RANGE) {
        errno = ENOSYS;
        return -1;
    }

    va_list args;
    va_start(args, number);
    long a1 = va_arg(args, long);
    long a2 = va_arg(args, long);
    long a3 = va_arg(args, long);
    long a4 = va_arg(args, long);
    long a5 = va_arg(args, long);
    long a6 = va_arg(args, long);
    va_end(args);

    long result = raw_syscall(number, a1, a2, a3, a4, a5, a6);
    if (result < 0 && result >= -4095) {
        errno = (int)-result;
        return -1;
    }
    return result;
}
