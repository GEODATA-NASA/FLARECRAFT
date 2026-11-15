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
        string python = Path.Combine(root, "app", "python", "python.exe");
        string script = Path.Combine(root, "app", "launch.py");
        if (!File.Exists(python) || !File.Exists(script))
        {
            Console.WriteLine("The app folder is missing. Keep GeoFlare.exe next to the \"app\" folder it came with.");
            Console.ReadLine();
            return 1;
        }
        var start = new ProcessStartInfo(python, "\"" + script + "\"") { UseShellExecute = false, WorkingDirectory = Path.Combine(root, "app") };
        using (var process = Process.Start(start))
        {
            process.WaitForExit();
            return process.ExitCode;
        }
    }
}
