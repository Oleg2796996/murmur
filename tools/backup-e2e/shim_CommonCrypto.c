#include "include/shim.h"
#include <openssl/evp.h>
int murmur_CCKeyDerivationPBKDF(uint32_t algorithm,
                                const char *password, size_t passwordLen,
                                const uint8_t *salt, size_t saltLen,
                                uint32_t prf,
                                uint32_t iterations,
                                uint8_t *derivedKey, size_t derivedKeyLen) {
    if (algorithm != 2 /* kCCPBKDF2 */) return -1;
    if (prf != 3 /* kCCPRFHmacAlgSHA256 */) return -2;
    if (!password || !salt || !derivedKey) return -3;
    if (!passwordLen || !saltLen || !iterations || !derivedKeyLen) return -4;
    if (PKCS5_PBKDF2_HMAC((const char *)password, (int)passwordLen,
                          salt, (int)saltLen, (int)iterations,
                          EVP_sha256(), (int)derivedKeyLen, derivedKey) != 1) return -5;
    return 0;
}
