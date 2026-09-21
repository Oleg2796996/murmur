/* @ts-self-types="./murmur_id_wasm.d.ts" */

export function _start() {
    wasm._start();
}

/**
 * Forget the in-memory private key. After this call, `sign_message` returns
 * an error until `identity_new()` is invoked again.
 */
export function clear_identity() {
    wasm.clear_identity();
}

/**
 * ECIES-decrypt a sealed envelope (base64) produced by `encrypt_for_recipient`.
 *
 * Returns the original plaintext as base64. The sender is anonymous in ECIES
 * (only ephemeral pubkey is known); sender authentication must come from the
 * outer envelope's ed25519 signature, not from ECIES.
 * @param {string} sealed_b64
 * @returns {any}
 */
export function decrypt_envelope(sealed_b64) {
    const ptr0 = passStringToWasm0(sealed_b64, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.decrypt_envelope(ptr0, len0);
    return takeObject(ret);
}

/**
 * ECIES-encrypt arbitrary bytes (base64 in/out) for a recipient identified by their npub.
 *
 * Returns a base64-encoded `SealedEnvelope`:
 *
 *   [ephemeral_pubkey: 32 bytes][nonce: 12 bytes][ciphertext + 16-byte GCM tag]
 *
 * Plaintext is opaque to the relay. Use for text bodies, JSON envelopes, file
 * blobs — up to ~50 MB on modern browsers before JS-side memory pressure.
 * @param {string} recipient_npub
 * @param {string} plaintext_b64
 * @returns {any}
 */
export function encrypt_for_recipient(recipient_npub, plaintext_b64) {
    const ptr0 = passStringToWasm0(recipient_npub, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(plaintext_b64, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.encrypt_for_recipient(ptr0, len0, ptr1, len1);
    return takeObject(ret);
}

/**
 * Decrypt a group message (base64 in/out) with the per-epoch group key.
 * @param {string} group_key_hex
 * @param {bigint} epoch
 * @param {string} group_id
 * @param {string} sender_npub
 * @param {string} sealed_b64
 * @returns {any}
 */
export function group_decrypt(group_key_hex, epoch, group_id, sender_npub, sealed_b64) {
    const ptr0 = passStringToWasm0(group_key_hex, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(group_id, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(sender_npub, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passStringToWasm0(sealed_b64, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.group_decrypt(ptr0, len0, epoch, ptr1, len1, ptr2, len2, ptr3, len3);
    return takeObject(ret);
}

/**
 * Encrypt a group message (base64 in/out) with the per-epoch group key.
 * AAD binds group_id + sender_npub + epoch — tamper/replay fails the tag.
 * @param {string} group_key_hex
 * @param {bigint} epoch
 * @param {string} group_id
 * @param {string} sender_npub
 * @param {string} plaintext_b64
 * @returns {any}
 */
export function group_encrypt(group_key_hex, epoch, group_id, sender_npub, plaintext_b64) {
    const ptr0 = passStringToWasm0(group_key_hex, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(group_id, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(sender_npub, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passStringToWasm0(plaintext_b64, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.group_encrypt(ptr0, len0, epoch, ptr1, len1, ptr2, len2, ptr3, len3);
    return takeObject(ret);
}

/**
 * Generate a fresh random 32-byte group master key (hex). Creator calls this
 * once on group creation; the key is distributed to members via 1:1 ECIES.
 * @returns {any}
 */
export function group_new_key() {
    const ret = wasm.group_new_key();
    return takeObject(ret);
}

/**
 * Generate a new murmur identity. Stores the postcard-serialized secret
 * internally so subsequent `sign_message` calls can use it.
 * @returns {any}
 */
export function identity_new() {
    const ret = wasm.identity_new();
    return takeObject(ret);
}

/**
 * Restore a previously-generated identity from its full postcard-serialized bytes (hex-encoded).
 * Use the `signing_sk_hex` field returned by `identity_new()` — it contains the entire
 * private state (signing + agreement keys) needed to reconstruct the Identity.
 * Returns the same IdentityInfo as identity_new(), and primes the in-memory key
 * for subsequent sign_message calls.
 * @param {string} sk_hex
 * @returns {any}
 */
export function identity_restore(sk_hex) {
    const ptr0 = passStringToWasm0(sk_hex, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.identity_restore(ptr0, len0);
    return takeObject(ret);
}

/**
 * Resolve an npub to its 64-byte public-key bundle (signing + agreement),
 * hex-encoded. Useful for the JS side to display fingerprints.
 * @param {string} npub
 * @returns {any}
 */
export function npub_to_pubkey_hex(npub) {
    const ptr0 = passStringToWasm0(npub, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.npub_to_pubkey_hex(ptr0, len0);
    return takeObject(ret);
}

/**
 * Smoke-test roundtrip: takes a UTF-8 string and returns it wrapped in a
 * `JsCmdResult<String>` so the JS side can verify the WASM module is wired
 * correctly. Cheap and useful for "is the IPC alive?" checks.
 * @param {string} msg
 * @returns {any}
 */
export function ping(msg) {
    const ptr0 = passStringToWasm0(msg, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.ping(ptr0, len0);
    return takeObject(ret);
}

/**
 * Sign a canonical envelope payload the way the relay's `Envelope::verify`
 * expects: SHA3-256(domain || npub_len || npub || payload_len || payload)
 * then ed25519 over that digest. PWA passes the JSON bytes it actually sent
 * (e.g. the `from|to|ts|ct` string), relay re-derives the same digest and
 * verifies — so the server can never tamper with `ct` without breaking the
 * signature.
 * @param {string} sender_npub
 * @param {Uint8Array} payload
 * @returns {any}
 */
export function sign_envelope(sender_npub, payload) {
    const ptr0 = passStringToWasm0(sender_npub, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(payload, wasm.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.sign_envelope(ptr0, len0, ptr1, len1);
    return takeObject(ret);
}

/**
 * Sign a UTF-8 message with the in-memory private key. Returns the 64-byte
 * Schnorr signature as a hex string.
 * @param {string} msg
 * @returns {any}
 */
export function sign_message(msg) {
    const ptr0 = passStringToWasm0(msg, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.sign_message(ptr0, len0);
    return takeObject(ret);
}

/**
 * Return the package version, used for cache-busting.
 * @returns {string}
 */
export function version() {
    let deferred1_0;
    let deferred1_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.version(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred1_0 = r0;
        deferred1_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
    }
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_is_function_5e4570eb24ffa122: function(arg0) {
            const ret = typeof(getObject(arg0)) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_object_a2790eb24c211ea0: function(arg0) {
            const val = getObject(arg0);
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_e6f02f0ea5f20a32: function(arg0) {
            const ret = typeof(getObject(arg0)) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_6cff064c44e0d823: function(arg0) {
            const ret = getObject(arg0) === undefined;
            return ret;
        },
        __wbg___wbindgen_throw_bb96b2010945f0bc: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_call_35dba3c747ad7521: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = getObject(arg0).call(getObject(arg1), getObject(arg2));
            return addHeapObject(ret);
        }, arguments); },
        __wbg_crypto_38df2bab126b63dc: function(arg0) {
            const ret = getObject(arg0).crypto;
            return addHeapObject(ret);
        },
        __wbg_error_dd408a7b3cb542dd: function(arg0) {
            console.error(getObject(arg0));
        },
        __wbg_getRandomValues_c44a50d8cfdaebeb: function() { return handleError(function (arg0, arg1) {
            getObject(arg0).getRandomValues(getObject(arg1));
        }, arguments); },
        __wbg_length_36bd29c6848c2144: function(arg0) {
            const ret = getObject(arg0).length;
            return ret;
        },
        __wbg_msCrypto_bd5a034af96bcba6: function(arg0) {
            const ret = getObject(arg0).msCrypto;
            return addHeapObject(ret);
        },
        __wbg_new_with_length_2ccc5dbfb4541247: function(arg0) {
            const ret = new Array(arg0 >>> 0);
            return addHeapObject(ret);
        },
        __wbg_new_with_length_3ffc1c56427c525c: function(arg0) {
            const ret = new Uint8Array(arg0 >>> 0);
            return addHeapObject(ret);
        },
        __wbg_node_84ea875411254db1: function(arg0) {
            const ret = getObject(arg0).node;
            return addHeapObject(ret);
        },
        __wbg_process_44c7a14e11e9f69e: function(arg0) {
            const ret = getObject(arg0).process;
            return addHeapObject(ret);
        },
        __wbg_prototypesetcall_de8e0d9553586985: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), getObject(arg2));
        },
        __wbg_randomFillSync_6c25eac9869eb53c: function() { return handleError(function (arg0, arg1) {
            getObject(arg0).randomFillSync(takeObject(arg1));
        }, arguments); },
        __wbg_require_b4edbdcf3e2a1ef0: function() { return handleError(function () {
            const ret = module.require;
            return addHeapObject(ret);
        }, arguments); },
        __wbg_set_a80955eb93b145c6: function(arg0, arg1, arg2) {
            getObject(arg0)[arg1 >>> 0] = takeObject(arg2);
        },
        __wbg_static_accessor_GLOBAL_THIS_466428f93b4eaa76: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addHeapObject(ret);
        },
        __wbg_static_accessor_GLOBAL_c7aea38d4de089bc: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addHeapObject(ret);
        },
        __wbg_static_accessor_SELF_42d4fae05e59267a: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addHeapObject(ret);
        },
        __wbg_static_accessor_WINDOW_e0db14a0eba6a812: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addHeapObject(ret);
        },
        __wbg_subarray_a4cc58201c7359fd: function(arg0, arg1, arg2) {
            const ret = getObject(arg0).subarray(arg1 >>> 0, arg2 >>> 0);
            return addHeapObject(ret);
        },
        __wbg_versions_276b2795b1c6a219: function(arg0) {
            const ret = getObject(arg0).versions;
            return addHeapObject(ret);
        },
        __wbindgen_cast_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return addHeapObject(ret);
        },
        __wbindgen_cast_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
            const ret = getArrayU8FromWasm0(arg0, arg1);
            return addHeapObject(ret);
        },
        __wbindgen_cast_0000000000000003: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return addHeapObject(ret);
        },
        __wbindgen_object_clone_ref: function(arg0) {
            const ret = getObject(arg0);
            return addHeapObject(ret);
        },
        __wbindgen_object_drop_ref: function(arg0) {
            takeObject(arg0);
        },
    };
    return {
        __proto__: null,
        "./murmur_id_wasm_bg.js": import0,
    };
}

function addHeapObject(obj) {
    if (heap_next === heap.length) heap.push(heap.length + 1);
    const idx = heap_next;
    heap_next = heap[idx];

    heap[idx] = obj;
    return idx;
}

function dropObject(idx) {
    if (idx < 1028) return;
    heap[idx] = heap_next;
    heap_next = idx;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function getObject(idx) { return heap[idx]; }

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        wasm.__wbindgen_export(addHeapObject(e));
    }
}

let heap = new Array(1024).fill(undefined);
heap.push(undefined, null, true, false);

let heap_next = heap.length;

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeObject(idx) {
    const ret = getObject(idx);
    dropObject(idx);
    return ret;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('murmur_id_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
