# agentos-shell: the native Qt 6 Shell (spec §10, §11). Imported by default.nix/shell.nix here and, later, by os/packages:
#   pkgs.callPackage ../../desktop/package.nix { }
# Source is the desktop/ tree plus the shared fixtures the tests compare against (fixtures/v1.0/slot-vectors etc.).
{ lib, stdenv, cmake, ninja, qt6, makeFontsConf, noto-fonts-cjk-sans, dejavu_fonts, nodejs ? null }:
let
  repo = ../.;
  src = lib.fileset.toSource {
    root = repo;
    fileset = lib.fileset.unions [
      (lib.fileset.difference ./. (lib.fileset.unions [ (lib.fileset.maybeMissing ./build) (lib.fileset.maybeMissing ./tests/out) ]))
      ../fixtures/todo-v1.json
      ../fixtures/todo-v2.json
      ../fixtures/v0.2/todo-kanban
      ../fixtures/v1.0/protocol
      ../fixtures/v1.0/slot-vectors
    ];
  };
in
stdenv.mkDerivation {
  pname = "agentos-shell";
  version = "1.0.0";
  inherit src;
  sourceRoot = "${src.name}/desktop";
  nativeBuildInputs = [ cmake ninja qt6.wrapQtAppsHook ];
  buildInputs = [ qt6.qtbase qt6.qtdeclarative qt6.qtwayland ];
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    export QT_QPA_PLATFORM=offscreen QT_QUICK_BACKEND=software HOME=$TMPDIR XDG_RUNTIME_DIR=$TMPDIR
    # The build sandbox has no fontconfig setup; render tests need real glyphs (CJK included) or text renders blank.
    export FONTCONFIG_FILE=${makeFontsConf { fontDirectories = [ noto-fonts-cjk-sans dejavu_fonts ]; }}
    export QML_IMPORT_PATH=${qt6.qtdeclarative}/${qt6.qtbase.qtQmlPrefix}
    export QT_PLUGIN_PATH=${qt6.qtbase}/${qt6.qtbase.qtPluginPrefix}:${qt6.qtdeclarative}/${qt6.qtbase.qtPluginPrefix}
    ctest --output-on-failure -j1
    # V1-O07 binding fuzz: three more seeds × 2000 rounds besides the default run inside ctest; print the summaries
    for seed in 1 2 3; do
      AGENTOS_FUZZ_SEED=$seed AGENTOS_FUZZ_ROUNDS=2000 ./slot_vectors bindingFuzz > fuzz-$seed.log 2>&1 || { cat fuzz-$seed.log; exit 1; }
      grep -E "binding fuzz:|^Totals" fuzz-$seed.log
    done
    runHook postCheck
  '';
  meta = { description = "AgentOS v1.0 native Qt Shell"; mainProgram = "agentos-shell"; platforms = lib.platforms.linux; };
}
