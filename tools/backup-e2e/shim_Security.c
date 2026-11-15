#include "include/security_shim.h"
#include <stdio.h>
#include <errno.h>
int murmur_SecRandomCopyBytes(int32_t rnd, uint8_t *bytes, size_t count) {
    (void)rnd;
    FILE *f = fopen("/dev/urandom", "rb");
    if (!f) return -1;
    size_t n = fread(bytes, 1, count, f);
    fclose(f);
    return (n == count) ? 0 : -1;
}
