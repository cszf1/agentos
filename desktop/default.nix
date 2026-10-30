# nix-build desktop            -> result/bin/agentos-shell (ctest runs in checkPhase)
{ pkgs ? import ./nixpkgs.nix { } }:
{
  package = pkgs.callPackage ./package.nix { };
}
