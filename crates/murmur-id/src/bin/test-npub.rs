use bech32::{decode, FromBase32};
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let npub = &args[1];
    let r = decode(npub);
    match r {
        Ok((hrp, data, _)) => {
            println!("OK hrp={} data.len={}", hrp, data.len());
            match Vec::from_base32(&data) {
                Ok(bytes) => println!("bytes len: {}", bytes.len()),
                Err(e) => println!("from_base32 ERR: {:?}", e),
            }
        }
        Err(e) => println!("ERR: {:?}", e),
    }
}
