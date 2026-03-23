{
  description = "Unix-based personal assistant";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        packages.default = pkgs.buildGoModule {
          pname = "tobor";
          version = "0.1.0";
          src = ./.;
          vendorHash = "sha256-Y4aV+9tQFqU2tgE/ymeHCKRSfyeGdZdMyqn7BshVeDE=";
          subPackages = [ "cmd/tobor" ];

          meta = with pkgs.lib; {
            description = "Unix-based personal assistant";
            homepage = "https://github.com/arjungandhi/tobor";
            license = licenses.mit;
            mainProgram = "tobor";
          };
        };

        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            go
            gopls
            just
          ];
        };
      }
    );
}
