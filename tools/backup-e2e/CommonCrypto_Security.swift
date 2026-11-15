// Linux shim: Apple's Security.framework SecRandomCopyBytes over /dev/urandom.
import Foundation
import SecurityShimC

public let kSecRandomDefault: Int32 = -1

@discardableResult
public func SecRandomCopyBytes(_ rnd: Int32, _ count: Int, _ bytes: UnsafeMutableRawPointer!) -> Int32 {
    murmur_SecRandomCopyBytes(rnd, bytes.assumingMemoryBound(to: UInt8.self), count)
}
