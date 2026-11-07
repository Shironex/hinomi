// Leaves a marker when it runs; the lockfile step must never run it.
fn main() {
    std::fs::write(concat!(env!("CARGO_MANIFEST_DIR"), "/build-ran"), "").unwrap();
}
