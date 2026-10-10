package com.craftagents.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.IBinder;
import android.os.PowerManager;
import java.io.File;
import java.io.FileDescriptor;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

/** Keeps the on-device backend independent of the WebView/activity lifecycle. */
public final class LocalAgentService extends Service {
    private static final String CHANNEL = "local_agent";
    private static final int NOTIFICATION_ID = 7101;
    private static LocalAgentServer sharedServer;
    private final ScheduledExecutorService monitor = Executors.newSingleThreadScheduledExecutor();
    private PowerManager.WakeLock wakeLock;
    private volatile boolean processing;
    private boolean stopping;
    private volatile long lastTaskCheck;

    static synchronized LocalAgentServer server(Context context) {
        if (sharedServer == null) sharedServer = new LocalAgentServer(context.getApplicationContext());
        return sharedServer;
    }

    static void start(Context context) {
        context.startForegroundService(new Intent(context, LocalAgentService.class));
    }

    private final Runnable checkTasks = new Runnable() {
        @Override public void run() {
            boolean running = false;
            File state = new File(getFilesDir(), "craft-agent-server/android-task-state.json");
            try {
                if (server(LocalAgentService.this).isRunning() && state.isFile()) {
                    JSONObject status = new JSONObject(new String(Files.readAllBytes(state.toPath()), StandardCharsets.UTF_8));
                    running = status.optInt("processing", 0) > 0;
                }
            } catch (Exception ignored) {
                // A transient state-file read must not release an active task's lock.
                running = processing && server(LocalAgentService.this).isRunning();
            }
            synchronized (LocalAgentService.this) {
                if (stopping) return;
                lastTaskCheck = System.currentTimeMillis();
                // Renew a bounded lock while the backend reports active work.
                if (running) wakeLock.acquire(60_000L);
                else if (wakeLock.isHeld()) wakeLock.release();
                if (running != processing) {
                    processing = running;
                    getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, notification());
                }
            }
        }
    };

    @Override public void onCreate() {
        super.onCreate();
        getSystemService(NotificationManager.class).createNotificationChannel(
                new NotificationChannel(CHANNEL, getString(R.string.background_channel), NotificationManager.IMPORTANCE_LOW));
        wakeLock = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, getPackageName() + ":agent-task");
        wakeLock.setReferenceCounted(false);
        startForeground(NOTIFICATION_ID, notification());
        monitor.scheduleWithFixedDelay(checkTasks, 0L, 1L, TimeUnit.SECONDS);
    }

    private Notification notification() {
        Intent intent = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent open = PendingIntent.getActivity(this, 7101, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_launcher)
                .setContentTitle(getString(R.string.app_name))
                .setContentText(getString(processing ? R.string.background_processing : R.string.background_ready))
                .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true).build();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        return START_NOT_STICKY;
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override protected void dump(FileDescriptor fd, PrintWriter writer, String[] args) {
        writer.println("processing=" + processing + " wakeLockHeld=" + (wakeLock != null && wakeLock.isHeld()));
        writer.println("lastTaskCheck=" + lastTaskCheck + " backendRunning=" + server(this).isRunning());
    }

    @Override public void onDestroy() {
        monitor.shutdownNow();
        synchronized (this) {
            stopping = true;
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        }
        server(this).stop();
        super.onDestroy();
    }
}
