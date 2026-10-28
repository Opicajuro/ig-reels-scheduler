// Localirs.exe: starts Localirs with no console window, sits in the tray, and opens the app in its own Edge window.
// Built by installer\build-installer.ps1 with the C# compiler that ships with .NET Framework 4, so it is C# 5.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Threading;
using System.Windows.Forms;

static class Launcher
{
    const string AppUrl = "http://localhost:3000/";
    const string ReadyUrl = "http://127.0.0.1:3000/";
    const int StartTimeoutSeconds = 180;

    static readonly string InstallDir = Path.GetDirectoryName(Application.ExecutablePath);
    static readonly string DataDir = Path.Combine(InstallDir, "data");

    static NotifyIcon tray;
    static Process starter;
    static System.Windows.Forms.Timer poll;
    static DateTime startedAt;

    [STAThread]
    static void Main()
    {
        bool firstCopy;
        // The installer checks for this name too (AppMutex), so it asks you to quit Localirs before an update.
        using (Mutex mutex = new Mutex(true, "Localirs.Launcher", out firstCopy))
        {
            if (!firstCopy)
            {
                // Localirs is already running: opening the icon again just opens the window.
                if (IsReady()) OpenWindow();
                return;
            }
            Application.EnableVisualStyles();
            tray = new NotifyIcon();
            tray.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            tray.Text = "Localirs - starting...";
            tray.Visible = true;
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add("Open Localirs", null, delegate { OpenWindow(); });
            menu.Items.Add("Open logs folder", null, delegate { Process.Start("explorer.exe", "\"" + DataDir + "\""); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Quit Localirs", null, delegate { Quit(); });
            tray.ContextMenuStrip = menu;
            tray.DoubleClick += delegate { OpenWindow(); };

            starter = RunScript("start-localirs.ps1");
            startedAt = DateTime.Now;
            poll = new System.Windows.Forms.Timer();
            poll.Interval = 1000;
            poll.Tick += delegate { CheckStart(); };
            poll.Start();

            Application.Run();
            tray.Visible = false;
        }
    }

    // Runs one of the PowerShell scripts next to this program, with no window.
    static Process RunScript(string name)
    {
        ProcessStartInfo info = new ProcessStartInfo("powershell.exe",
            "-NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(InstallDir, name) + "\"");
        info.WorkingDirectory = InstallDir;
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        return Process.Start(info);
    }

    // Called every second while starting: fails on a start-script error or a timeout, opens the window when ready.
    static void CheckStart()
    {
        if (starter.HasExited && starter.ExitCode != 0)
        {
            Fail("Localirs did not start.");
            return;
        }
        if (starter.HasExited && IsReady())
        {
            poll.Stop();
            tray.Text = "Localirs - running";
            OpenWindow();
            return;
        }
        if ((DateTime.Now - startedAt).TotalSeconds > StartTimeoutSeconds)
        {
            Fail("Localirs did not answer within " + StartTimeoutSeconds + " seconds.");
        }
    }

    static void Fail(string headline)
    {
        poll.Stop();
        tray.Text = "Localirs - not running";
        string log = Path.Combine(DataDir, "start.log");
        string tail = File.Exists(log) ? string.Join(Environment.NewLine, File.ReadAllLines(log).Reverse().Take(12).Reverse()) : "";
        MessageBox.Show(headline + Environment.NewLine + Environment.NewLine + tail + Environment.NewLine + Environment.NewLine +
            "The full log is " + log, "Localirs", MessageBoxButtons.OK, MessageBoxIcon.Error);
        Application.Exit();
    }

    // Any HTTP answer from the web app means it is up, even an error page.
    static bool IsReady()
    {
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(ReadyUrl);
        request.Timeout = 800;
        try
        {
            request.GetResponse().Close();
            return true;
        }
        catch (WebException e)
        {
            if (e.Response != null)
            {
                e.Response.Close();
                return true;
            }
            return false;
        }
    }

    // Opens Localirs as its own window, without tabs or an address bar, using Edge's app mode.
    static void OpenWindow()
    {
        ProcessStartInfo info = new ProcessStartInfo("msedge.exe", "--app=" + AppUrl);
        info.UseShellExecute = true;
        try
        {
            Process.Start(info);
        }
        catch (Win32Exception)
        {
            MessageBox.Show("Localirs opens in a Microsoft Edge window, and Edge was not found on this PC." +
                Environment.NewLine + Environment.NewLine + "Install Microsoft Edge, or open " + AppUrl + " in any browser.",
                "Localirs", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    static void Quit()
    {
        DialogResult answer = MessageBox.Show("Scheduled Reels are not published while Localirs is stopped." +
            Environment.NewLine + Environment.NewLine + "Quit Localirs?", "Localirs", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
        if (answer != DialogResult.Yes) return;
        poll.Stop();
        tray.Text = "Localirs - stopping...";
        Process stopper = RunScript("stop-localirs.ps1");
        stopper.WaitForExit(60000);
        if (!stopper.HasExited || stopper.ExitCode != 0)
        {
            MessageBox.Show("Localirs did not stop cleanly. See " + Path.Combine(DataDir, "stop.log"),
                "Localirs", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        Application.Exit();
    }
}
