#ifndef MURMUR_SECURITY_SHIM_H
#define MURMUR_SECURITY_SHIM_H
#include <stdint.h>
#include <stddef.h>
#include <stddef.h>
int murmur_SecRandomCopyBytes(int32_t rnd, uint8_t *bytes, size_t count);
#endif
