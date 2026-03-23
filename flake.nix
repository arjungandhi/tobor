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
          vendorHash = "sha256-P+yyB0H1+UMeeFA1uT5W21+OuDU4OPK20kCVz9WGeX8=";
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
