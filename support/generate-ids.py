#!/usr/bin/env python3

import sys

if len(sys.argv) != 3:
    print(f"Usage: {sys.argv[0]} <start> <end>")
    sys.exit(1)

try:
    start = int(sys.argv[1])
    end = int(sys.argv[2])
except ValueError:
    print("Error: start and end must be integers.")
    sys.exit(1)

for i in range(start, end + 1):
    print(f"{i},")