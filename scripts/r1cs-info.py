#!/usr/bin/env python3
"""Print constraint/signal counts from circom .r1cs files (binary header), as a markdown table."""
import struct, sys, os

def info(path):
    with open(path, "rb") as f:
        assert f.read(4) == b"r1cs", path
        _ver, nsec = struct.unpack("<II", f.read(8))
        for _ in range(nsec):
            typ, size = struct.unpack("<IQ", f.read(12))
            if typ == 1:
                fs = struct.unpack("<I", f.read(4))[0]
                f.read(fs)
                wires, pub_out, pub_in, prv_in = struct.unpack("<IIII", f.read(16))
                _labels, constraints = struct.unpack("<QI", f.read(12))
                return constraints, pub_out, pub_in, prv_in, wires
            f.seek(size, 1)
    raise ValueError(f"no header in {path}")

print("| Circuit | Constraints | Public outputs | Public inputs | Private inputs | Wires |")
print("|---|---:|---:|---:|---:|---:|")
for p in sys.argv[1:]:
    c, po, pi, pr, w = info(p)
    print(f"| `{os.path.basename(p)[:-5]}` | {c:,} | {po} | {pi} | {pr} | {w:,} |")
