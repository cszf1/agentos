# The same nixpkgs revision as os/flake.nix (nixos-26.05, Qt 6.11.2). narHash from os/flake.lock.
import (builtins.fetchTarball {
  url = "https://github.com/NixOS/nixpkgs/archive/6f06d204d8f2d8761d9da78778745974a3216381.tar.gz";
  sha256 = "sha256-loLMnbbS4KhmG2ln9EY6f0YMNCA273Yx02oWYQ9IMeE=";
})
