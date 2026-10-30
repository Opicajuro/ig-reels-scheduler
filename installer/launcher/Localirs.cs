// Localirs.exe: starts Localirs with no console window, sits in the tray, and opens the app in its own Edge window.
// Built by installer\build-installer.ps1 with the C# compiler that ships with .NET Framework 4, so it is C# 5.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

static class Launcher
{
    const string AppUrl = "http://localhost:3000/";
    const string ReadyUrl = "http://127.0.0.1:3000/";
    const int StartTimeoutSeconds = 180;
    // Each installer build is published as a release tagged localirs-build-<n> (.github/workflows/windows-installer.yml).
    const string LatestReleaseUrl = "https://api.github.com/repos/Opicajuro/ig-reels-scheduler/releases/latest";

    static readonly string InstallDir = Path.GetDirectoryName(Application.ExecutablePath);
    static readonly string DataDir = Path.Combine(InstallDir, "data");

    static NotifyIcon tray;
    static Process starter;
    static System.Windows.Forms.Timer poll;
    static DateTime startedAt;
    static Mutex mutex;
    static ToolStripMenuItem checkItem;
    static ToolStripMenuItem installItem;
    static int updateBuild;
    static string updateUrl;

    [STAThread]
    static void Main()
    {
        bool firstCopy;
        // The installer checks for this name too (AppMutex), so it asks you to quit Localirs before an update.
        using (mutex = new Mutex(true, "Localirs.Launcher", out firstCopy))
        {
            if (!firstCopy)
            {
                // Localirs is already running: opening the icon again just opens the window.
                if (IsReady()) OpenWindow();
                return;
            }
            Application.EnableVisualStyles();
            // GitHub only accepts TLS 1.2, which .NET Framework 4 does not use by default.
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            tray = new NotifyIcon();
            tray.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            tray.Text = "Localirs - starting...";
            tray.Visible = true;
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add("Open Localirs", null, delegate { OpenWindow(); });
            checkItem = new ToolStripMenuItem("Check for updates", null, delegate { CheckForUpdates(true); });
            menu.Items.Add(checkItem);
            installItem = new ToolStripMenuItem("Install update", null, delegate { InstallUpdate(); });
            installItem.Enabled = false;
            menu.Items.Add(installItem);
            menu.Items.Add("Open logs folder", null, delegate { Process.Start("explorer.exe", "\"" + DataDir + "\""); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Quit Localirs", null, delegate { Quit(); });
            tray.ContextMenuStrip = menu;
            tray.DoubleClick += delegate { OpenWindow(); };
            tray.BalloonTipClicked += delegate { if (installItem.Enabled) InstallUpdate(); };

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
            CheckForUpdates(false);
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
        string tail = File.Exists(log) ? string.Join(Environment.NewLine, TranscriptBody(File.ReadAllLines(log)).Reverse().Take(20).Reverse()) : "";
        MessageBox.Show(headline + Environment.NewLine + Environment.NewLine + tail + Environment.NewLine + Environment.NewLine +
            "The full log is " + log, "Localirs", MessageBoxButtons.OK, MessageBoxIcon.Error);
        Application.Exit();
    }

    // A PowerShell transcript is a header, the script's output and a footer, each block between lines of asterisks.
    // Only the output says what went wrong.
    static string[] TranscriptBody(string[] lines)
    {
        int[] separators = Enumerable.Range(0, lines.Length).Where(i => lines[i].StartsWith("*****")).ToArray();
        if (separators.Length < 3) return lines;
        return lines.Skip(separators[1] + 1).Take(separators[2] - separators[1] - 1).ToArray();
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

    static WebClient NewWebClient()
    {
        WebClient client = new WebClient();
        // GitHub's API refuses requests without a User-Agent.
        client.Headers[HttpRequestHeader.UserAgent] = "Localirs";
        return client;
    }

    // Offers the newest release when its build is newer than this install's (version.txt, written by the installer).
    // Only a check from the menu says there is nothing new, or that the check failed.
    static void CheckForUpdates(bool fromMenu)
    {
        checkItem.Enabled = false;
        WebClient client = NewWebClient();
        client.DownloadStringCompleted += delegate(object sender, DownloadStringCompletedEventArgs e)
        {
            client.Dispose();
            checkItem.Enabled = true;
            try
            {
                if (e.Error != null) throw e.Error;
                int build;
                string url;
                ParseLatestRelease(e.Result, out build, out url);
                int installed = int.Parse(File.ReadAllText(Path.Combine(InstallDir, "version.txt")).Trim());
                if (build > installed)
                {
                    updateBuild = build;
                    updateUrl = url;
                    installItem.Text = "Install update (build " + build + ")";
                    installItem.Enabled = true;
                    tray.ShowBalloonTip(10000, "Localirs", "Localirs build " + build + " is available - click to update", ToolTipIcon.Info);
                }
                else if (fromMenu)
                {
                    tray.ShowBalloonTip(5000, "Localirs", "Localirs is up to date (build " + installed + ").", ToolTipIcon.Info);
                }
            }
            catch (Exception error)
            {
                if (fromMenu) MessageBox.Show("Could not check for updates." + Environment.NewLine + Environment.NewLine + error.Message,
                    "Localirs", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        };
        client.DownloadStringAsync(new Uri(LatestReleaseUrl));
    }

    // Reads the build number from the release tag (localirs-build-<n>) and the URL of its Localirs-Setup.exe
    // from GitHub's releases/latest answer.
    internal static void ParseLatestRelease(string json, out int build, out string url)
    {
        Match tag = Regex.Match(json, "\"tag_name\"\\s*:\\s*\"localirs-build-(\\d+)\"");
        Match asset = Regex.Match(json, "\"browser_download_url\"\\s*:\\s*\"(https://[^\"]*/Localirs-Setup\\.exe)\"");
        if (!tag.Success || !asset.Success) throw new FormatException("The newest release is not a Localirs build with Localirs-Setup.exe.");
        build = int.Parse(tag.Groups[1].Value);
        url = asset.Groups[1].Value;
    }

    // Downloads the new installer to the temp folder and runs it silently over this install, then quits. Setup stops
    // the services (PrepareToInstall), keeps the data and settings, and opens Localirs again when it is done.
    static void InstallUpdate()
    {
        DialogResult answer = MessageBox.Show("Localirs downloads build " + updateBuild + ", then stops, updates and opens again. " +
            "Scheduled Reels are not published while it updates, which takes a minute or two." +
            Environment.NewLine + Environment.NewLine + "Update Localirs now?", "Localirs", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
        if (answer != DialogResult.Yes) return;
        checkItem.Enabled = false;
        installItem.Enabled = false;
        string setup = Path.Combine(Path.GetTempPath(), "Localirs-Setup-" + updateBuild + ".exe");
        WebClient client = NewWebClient();
        client.DownloadProgressChanged += delegate(object sender, DownloadProgressChangedEventArgs e)
        {
            tray.Text = "Localirs - downloading update " + e.ProgressPercentage + "%";
        };
        client.DownloadFileCompleted += delegate(object sender, AsyncCompletedEventArgs e)
        {
            try
            {
                if (e.Error != null) throw e.Error;
                // GitHub publishes no hash for release files, so this only checks that the whole file arrived.
                string length = client.ResponseHeaders[HttpResponseHeader.ContentLength];
                if (length == null) throw new IOException("GitHub did not say how big the installer is.");
                long downloaded = new FileInfo(setup).Length;
                if (downloaded != long.Parse(length)) throw new IOException("Downloaded " + downloaded + " of " + length + " bytes.");
            }
            catch (Exception error)
            {
                tray.Text = "Localirs - running";
                checkItem.Enabled = true;
                installItem.Enabled = true;
                MessageBox.Show("The update did not download." + Environment.NewLine + Environment.NewLine + error.Message,
                    "Localirs", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            finally
            {
                client.Dispose();
            }
            // Setup waits while this mutex is held (AppMutex), so let it go before starting setup.
            mutex.ReleaseMutex();
            mutex.Close();
            // No /SUPPRESSMSGBOXES: if the update fails (for example Localirs cannot be stopped), setup shows why.
            Process.Start(setup, "/SILENT /NORESTART /DIR=\"" + InstallDir + "\"");
            Application.Exit();
        };
        client.DownloadFileAsync(new Uri(updateUrl), setup);
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
