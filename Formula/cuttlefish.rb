class Cuttlefish < Formula
  desc "Lightweight AI gateway daemon orchestrating Claude Code and Codex"
  homepage "https://github.com/e3742526/cuttlefish"
  url "https://registry.npmjs.org/cuttlefish-cli/-/cuttlefish-cli-0.1.0.tgz"
  sha256 "c8d3eae160a892e32837db3dcae515e843e5383fef52b8141940c8bcf8b6d59f"
  license "MIT"

  livecheck do
    url "https://registry.npmjs.org/cuttlefish-cli"
    regex(/"latest":\s*"(\d+(?:\.\d+)+)"/)
  end

  depends_on "node@24"
  depends_on "python" => :build

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  def caveats
    <<~EOS
      To get started, run:
        cuttlefish setup

      Then start the gateway daemon:
        cuttlefish start

      The web dashboard will be available at http://localhost:8888
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/cuttlefish --version")
    assert_match "Usage", shell_output("#{bin}/cuttlefish --help")

    cd libexec/"lib/node_modules/cuttlefish-cli" do
      system "node", "-e", "require('better-sqlite3')"
    end
  end
end
