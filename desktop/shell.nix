# nix-shell desktop/shell.nix  -> qtbase, qtdeclarative, qtwayland, cmake, ninja from the pinned revision
{ pkgs ? import ./nixpkgs.nix { } }:
let pkg = pkgs.callPackage ./package.nix { };
in pkgs.mkShell {
  inputsFrom = [ pkg ];
  packages = [ pkgs.cmake pkgs.ninja pkgs.qt6.qtbase pkgs.qt6.qtdeclarative pkgs.qt6.qtwayland ];
  shellHook = ''
    export QML_IMPORT_PATH=${pkgs.qt6.qtdeclarative}/${pkgs.qt6.qtbase.qtQmlPrefix}
    export QT_PLUGIN_PATH=${pkgs.qt6.qtbase}/${pkgs.qt6.qtbase.qtPluginPrefix}:${pkgs.qt6.qtdeclarative}/${pkgs.qt6.qtbase.qtPluginPrefix}:${pkgs.qt6.qtwayland}/${pkgs.qt6.qtbase.qtPluginPrefix}
  '';
}
