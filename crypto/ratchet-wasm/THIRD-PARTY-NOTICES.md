# Third-party notices

`cipher-ratchet-wasm` depends on `vodozemac` 0.11.2 from Matrix.org. The
crate is licensed Apache-2.0; its license text is preserved in
`VODOZEMAC-LICENSE-APACHE-2.0.txt`. The dependency is pinned in `Cargo.toml`
and `Cargo.lock`.

The 2022 Least Authority report is evidence about the older revision it names,
not this pinned crate version, this adapter or Cipher. The adapter explicitly
selects vodozemac's feature-gated experimental Olm v2 full-MAC mode and rejects
compatibility-mode session creation. This selection still requires an
independent review before a broad production rollout.
