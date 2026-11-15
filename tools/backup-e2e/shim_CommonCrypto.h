#ifndef MURMUR_COMMONCRYPTO_SHIM_H
#define MURMUR_COMMONCRYPTO_SHIM_H
#include <stdint.h>
#include <stddef.h>
typedef uint32_t CCPBKDFAlgorithm;
typedef uint32_t CCPseudoRandomAlgorithm;
/* Mirrors Apple's CCKeyDerivationPBKDF; 0 on success. */
int murmur_CCKeyDerivationPBKDF(uint32_t algorithm,
                                const char *password, size_t passwordLen,
                                const uint8_t *salt, size_t saltLen,
                                uint32_t prf,
                                uint32_t iterations,
                                uint8_t *derivedKey, size_t derivedKeyLen);
#endif
