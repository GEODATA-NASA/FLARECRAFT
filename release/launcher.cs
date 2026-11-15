// GeoFlare.exe: a double-click starter with Flick as its icon. It runs app\launch.py with the bundled Python in
// this window and waits, so closing the window stops GeoFlare. Built by release/build_release.py with the C#
// compiler that ships with Windows (csc.exe, .NET Framework 4).
using System;
using System.Diagnostics;
using System.IO;

class GeoFlare
{
    static int Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        // The release folder carries app\python; a repository clone runs release\launch.py with its own .venv.
        string python = Path.Combine(root, "app", "python", "python.exe"), script = Path.Combine(root, "app", "launch.py");
        if (!File.Exists(python))
        {
            python = Path.Combine(root, ".venv", "Scripts", "python.exe");
            script = Path.Combine(root, "release", "launch.py");
        }
        if (!File.Exists(python) || !File.Exists(script))
        {
            Console.WriteLine("GeoFlare is not set up here. In the release folder keep GeoFlare.exe next to \"app\";");
            Console.WriteLine("in a repository clone run run_pipeline_and_servers.cmd once first (see GEOFLARE_GUIDE.md).");
            Console.ReadLine();
            return 1;
        }
        var start = new ProcessStartInfo(python, "\"" + script + "\"") { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(script) };
        using (var process = Process.Start(start))
        {
            process.WaitForExit();
            return process.ExitCode;
        }
    }
}
