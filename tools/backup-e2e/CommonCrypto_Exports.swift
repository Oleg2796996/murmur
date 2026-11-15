// Linux shim module: mirrors Apple's CommonCrypto surface used by MurMur.
import CommonCryptoShimC

public typealias CCPBKDFAlgorithm = UInt32
public typealias CCPseudoRandomAlgorithm = UInt32
public let kCCPBKDF2: CCPBKDFAlgorithm = 2
public let kCCPRFHmacAlgSHA256: CCPseudoRandomAlgorithm = 3
public let kCCSuccess: Int32 = 0

@discardableResult
public func CCKeyDerivationPBKDF(_ algorithm: CCPBKDFAlgorithm,
                                _ password: UnsafePointer<Int8>!, _ passwordLen: Int,
                                _ salt: UnsafePointer<UInt8>!, _ saltLen: Int,
                                _ prf: CCPseudoRandomAlgorithm,
                                _ iterations: UInt32,
                                _ derivedKey: UnsafeMutablePointer<UInt8>!, _ derivedKeyLen: Int) -> Int32 {
    murmur_CCKeyDerivationPBKDF(algorithm,
                                UnsafeRawPointer(password).assumingMemoryBound(to: CChar.self),
                                passwordLen,
                                salt, saltLen,
                                prf, iterations,
                                derivedKey, derivedKeyLen)
}
