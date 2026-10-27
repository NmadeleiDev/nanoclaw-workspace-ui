#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p dist/workspace-native .cache/workspace-swift
xcrun swiftc -parse-as-library -O -module-cache-path .cache/workspace-swift \
  src/modules/workspace-ui/apple-model.swift -o dist/workspace-native/apple-model
