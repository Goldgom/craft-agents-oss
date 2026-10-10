param([string]$StatePath, [string]$ClosePath, [string]$WindowTitle)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Web.Extensions
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing, System.Web.Extensions -TypeDefinition @'
using System;
using System.IO;
using System.Drawing;
using System.Windows.Forms;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
public class ComputerUseTestWindow : Form {
  [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr handle, int command);
  public class InputBox : TextBox {
    public int WheelCount;
    protected override void WndProc(ref Message m) {
      if (m.Msg == 0x020A) WheelCount++;
      base.WndProc(ref m);
    }
  }
  private InputBox input = new InputBox();
  private int clicks, drags;
  private Timer timer = new Timer();
  public ComputerUseTestWindow(string statePath, string closePath, string title) {
    Text = title; StartPosition = FormStartPosition.Manual;
    Location = new Point(100, 100); Size = new Size(520, 420);
    input.AccessibleName = "Test input"; input.Multiline = true;
    input.Location = new Point(20, 20); input.Size = new Size(450, 140);
    Controls.Add(input);
    var button = new Button(); button.Text = "Test click";
    button.Location = new Point(20, 180); button.Size = new Size(160, 40);
    button.Click += delegate { clicks++; }; Controls.Add(button);
    var panel = new Panel(); panel.AccessibleName = "Drag area";
    panel.Location = new Point(20, 240); panel.Size = new Size(450, 100);
    panel.BackColor = Color.LightBlue;
    bool down = false;
    panel.MouseDown += delegate { down = true; };
    panel.MouseUp += delegate { if (down) drags++; down = false; };
    Controls.Add(panel);
    timer.Interval = 100;
    bool revealed = false;
    timer.Tick += delegate {
      // The PowerShell host is launched hidden; explicitly show only this fixture.
      if (!revealed) { ShowWindow(Handle, 5); revealed = true; }
      var state = new { text = input.Text, clicks = clicks, drags = drags, wheelCount = input.WheelCount, windowId = Handle.ToInt64().ToString(), visible = Visible, title = Text };
      File.WriteAllText(statePath, new JavaScriptSerializer().Serialize(state));
      if (File.Exists(closePath)) Close();
    };
    timer.Start();
  }
  public static void Run(string statePath, string closePath, string title) {
    SetProcessDPIAware(); Application.EnableVisualStyles();
    Application.Run(new ComputerUseTestWindow(statePath, closePath, title));
  }
}
'@
[ComputerUseTestWindow]::Run($StatePath, $ClosePath, $WindowTitle)
