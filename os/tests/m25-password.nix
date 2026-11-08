{ pkgs, modules }:
pkgs.testers.runNixOSTest {
  name = "agentos-m25-password";
  nodes.machine = { ... }: {
    imports = modules;
    agentos.enable = true;
    agentos.graphical = false;
    virtualisation = { memorySize = 2048; cores = 2; diskSize = 4096; };
    environment.systemPackages = [ pkgs.python3 pkgs.cryptsetup pkgs.pamtester ];
    environment.etc."agentos-test/colon-password.py".source = ./m25-password.py;
  };
  testScript = ''
    machine.start()
    machine.wait_for_unit("agentos-machine.service")
    machine.succeed("python3 /etc/agentos-test/colon-password.py")
  '';
}
