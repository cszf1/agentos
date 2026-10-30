{ lib, stdenv, nodejs_24, pnpm_10, fetchPnpmDeps, makeWrapper, util-linux, coreutils, bash, src }:
stdenv.mkDerivation (finalAttrs: {
  pname = "agentos-node";
  version = "1.0.0";
  inherit src;
  nativeBuildInputs = [ nodejs_24 pnpm_10.configHook makeWrapper ];
  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    pnpm = pnpm_10;
    fetcherVersion = 2;
    hash = lib.fakeHash;
  };
  env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
  buildPhase = ''
    runHook preBuild
    pnpm build
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/agentos $out/bin
    cp -r package.json pnpm-workspace.yaml .node-version node_modules packages runtime fixtures docs bin $out/lib/agentos/
    patchShebangs $out/lib/agentos/bin
    for b in agentos-host agentos-admin agentos-runtime; do
      makeWrapper $out/lib/agentos/bin/$b $out/bin/$b \
        --set AGENTOS_NODE ${nodejs_24}/bin/node \
        --prefix PATH : ${lib.makeBinPath [ util-linux coreutils bash ]} \
        --set-default NODE_ENV production
    done
    runHook postInstall
  '';
  meta.description = "AgentOS Host, Pi harness adapter, web dev client and admin tools";
})
