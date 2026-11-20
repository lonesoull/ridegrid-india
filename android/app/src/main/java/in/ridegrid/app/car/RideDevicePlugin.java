package in.ridegrid.app.car;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.location.GnssStatus;
import android.location.LocationManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Phone features the web app can't reach: the next-turn notification (also on the lock screen),
 * waking the screen before a turn, the ambient-light sensor (night map) and GPS satellite status.
 */
@CapacitorPlugin(name = "RideDevice")
public class RideDevicePlugin extends Plugin implements SensorEventListener {
    private static final String CH = "ridegrid_nav";
    private static final int NOTE_ID = 4711;
    private float lux = -1;
    private int satsUsed = -1, satsSeen = -1;
    private float avgCn0 = 0;
    private GnssStatus.Callback gnss;

    @Override
    public void load() {
        SensorManager sm = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
        Sensor light = sm != null ? sm.getDefaultSensor(Sensor.TYPE_LIGHT) : null;
        if (light != null) sm.registerListener(this, light, SensorManager.SENSOR_DELAY_NORMAL);
    }

    @Override public void onSensorChanged(SensorEvent e) { lux = e.values[0]; }
    @Override public void onAccuracyChanged(Sensor s, int a) {}

    @PluginMethod
    public void status(PluginCall call) {
        startGnss();
        JSObject r = new JSObject();
        r.put("lux", lux); r.put("satsUsed", satsUsed); r.put("satsSeen", satsSeen); r.put("cn0", avgCn0);
        call.resolve(r);
    }

    private void startGnss() {
        if (gnss != null || Build.VERSION.SDK_INT < 24) return;
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) return;
        LocationManager lm = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
        if (lm == null) return;
        gnss = new GnssStatus.Callback() {
            @Override public void onSatelliteStatusChanged(GnssStatus s) {
                int used = 0; float sum = 0;
                for (int i = 0; i < s.getSatelliteCount(); i++) { if (s.usedInFix(i)) { used++; sum += s.getCn0DbHz(i); } }
                satsUsed = used; satsSeen = s.getSatelliteCount(); avgCn0 = used > 0 ? sum / used : 0;
            }
        };
        try { lm.registerGnssStatusCallback(gnss, new Handler(Looper.getMainLooper())); } catch (SecurityException ignored) { gnss = null; }
    }

    @PluginMethod
    public void notify(PluginCall call) {
        Context c = getContext();
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null && nm.getNotificationChannel(CH) == null) {
                NotificationChannel ch = new NotificationChannel(CH, "Navigation", NotificationManager.IMPORTANCE_LOW);
                ch.setDescription("Next turn while navigating"); ch.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);
                nm.createNotificationChannel(ch);
            }
        }
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(c, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            if (getActivity() != null) androidx.core.app.ActivityCompat.requestPermissions(getActivity(), new String[]{ Manifest.permission.POST_NOTIFICATIONS }, 4712);
            call.resolve(); return;
        }
        Intent open = c.getPackageManager().getLaunchIntentForPackage(c.getPackageName());
        PendingIntent pi = PendingIntent.getActivity(c, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CH)
            .setSmallIcon(c.getApplicationInfo().icon)
            .setContentTitle(call.getString("title", "RideGrid"))
            .setContentText(call.getString("text", ""))
            .setOngoing(true).setOnlyAlertOnce(true).setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setCategory(NotificationCompat.CATEGORY_NAVIGATION)
            .setContentIntent(pi);
        try { NotificationManagerCompat.from(c).notify(NOTE_ID, b.build()); } catch (SecurityException ignored) {}
        call.resolve();
    }

    @PluginMethod
    public void clear(PluginCall call) { NotificationManagerCompat.from(getContext()).cancel(NOTE_ID); call.resolve(); }

    /** Switch the screen on for a few seconds (before a turn) even when it timed out. */
    @SuppressWarnings("deprecation")
    @PluginMethod
    public void wake(PluginCall call) {
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            PowerManager.WakeLock wl = pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP | PowerManager.ON_AFTER_RELEASE, "ridegrid:turn");
            wl.acquire(call.getInt("ms", 12000));
        }
        call.resolve();
    }
}
