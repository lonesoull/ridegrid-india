package in.ridegrid.app.car;

import android.os.Handler;
import android.os.Looper;
import androidx.annotation.NonNull;
import androidx.car.app.CarContext;
import androidx.car.app.Screen;
import androidx.car.app.model.Action;
import androidx.car.app.model.ActionStrip;
import androidx.car.app.model.CarIcon;
import androidx.car.app.model.DateTimeWithZone;
import androidx.car.app.model.Distance;
import androidx.car.app.model.Template;
import androidx.car.app.navigation.NavigationManager;
import androidx.car.app.navigation.NavigationManagerCallback;
import androidx.car.app.navigation.model.Maneuver;
import androidx.car.app.navigation.model.MessageInfo;
import androidx.car.app.navigation.model.NavigationTemplate;
import androidx.car.app.navigation.model.RoutingInfo;
import androidx.car.app.navigation.model.Step;
import androidx.car.app.navigation.model.TravelEstimate;
import androidx.lifecycle.DefaultLifecycleObserver;
import androidx.lifecycle.LifecycleOwner;
import java.util.TimeZone;

/** Turn-by-turn card on the car / Android Auto screen, mirroring the phone's Daily navigation. */
public class NavScreen extends Screen implements NavState.Listener {
    private final Handler main = new Handler(Looper.getMainLooper());
    private final NavigationManager nav;
    private boolean started = false;

    public NavScreen(@NonNull CarContext ctx) {
        super(ctx);
        nav = ctx.getCarService(NavigationManager.class);
        nav.setNavigationManagerCallback(new NavigationManagerCallback() {
            @Override public void onStopNavigation() { started = false; invalidate(); }
        });
        getLifecycle().addObserver(new DefaultLifecycleObserver() {
            @Override public void onCreate(@NonNull LifecycleOwner o) { NavState.addListener(NavScreen.this); }
            @Override public void onDestroy(@NonNull LifecycleOwner o) { NavState.removeListener(NavScreen.this); if (started) nav.navigationEnded(); }
        });
    }

    @Override
    public void onChange() { main.post(this::invalidate); }

    private static int type(String t) {
        switch (t) {
            case "left": return Maneuver.TYPE_TURN_NORMAL_LEFT;
            case "right": return Maneuver.TYPE_TURN_NORMAL_RIGHT;
            case "slight-left": return Maneuver.TYPE_TURN_SLIGHT_LEFT;
            case "slight-right": return Maneuver.TYPE_TURN_SLIGHT_RIGHT;
            case "sharp-left": return Maneuver.TYPE_TURN_SHARP_LEFT;
            case "sharp-right": return Maneuver.TYPE_TURN_SHARP_RIGHT;
            case "uturn": return Maneuver.TYPE_U_TURN_RIGHT; // India drives on the left: U-turns go right
            case "keep-left": return Maneuver.TYPE_KEEP_LEFT;
            case "keep-right": return Maneuver.TYPE_KEEP_RIGHT;
            case "merge": return Maneuver.TYPE_MERGE_SIDE_UNSPECIFIED;
            case "ramp-left": return Maneuver.TYPE_ON_RAMP_NORMAL_LEFT;
            case "ramp-right": return Maneuver.TYPE_ON_RAMP_NORMAL_RIGHT;
            case "exit-left": return Maneuver.TYPE_OFF_RAMP_NORMAL_LEFT;
            case "exit-right": return Maneuver.TYPE_OFF_RAMP_NORMAL_RIGHT;
            case "roundabout": return Maneuver.TYPE_ROUNDABOUT_ENTER_AND_EXIT_CW; // clockwise in India
            default: return Maneuver.TYPE_STRAIGHT;
        }
    }

    private static Distance dist(double m) {
        return m >= 1000 ? Distance.create(Math.round(m / 100.0) / 10.0, Distance.UNIT_KILOMETERS) : Distance.create(Math.round(m / 10.0) * 10, Distance.UNIT_METERS);
    }

    @NonNull
    @Override
    public Template onGetTemplate() {
        ActionStrip strip = new ActionStrip.Builder().addAction(new Action.Builder().setTitle(NavState.speedKmh + " km/h").setOnClickListener(() -> {}).build()).build();
        NavigationTemplate.Builder b = new NavigationTemplate.Builder().setActionStrip(strip);
        if (NavState.navigating) {
            if (!started) { nav.navigationStarted(); started = true; }
            Maneuver.Builder mb = new Maneuver.Builder(type(NavState.turn)).setIcon(CarIcon.APP_ICON);
            if ("roundabout".equals(NavState.turn)) mb.setRoundaboutExitNumber(Math.max(1, NavState.exit));
            Step.Builder sb = new Step.Builder(NavState.text.isEmpty() ? "Continue" : NavState.text).setManeuver(mb.build());
            if (!NavState.road.isEmpty()) sb.setRoad(NavState.road);
            b.setNavigationInfo(new RoutingInfo.Builder().setCurrentStep(sb.build(), dist(NavState.distM)).build());
            if (NavState.etaMs > 0) {
                b.setDestinationTravelEstimate(new TravelEstimate.Builder(dist(NavState.remainingM), DateTimeWithZone.create(NavState.etaMs, TimeZone.getDefault()))
                    .setRemainingTimeSeconds(Math.max(0, (NavState.etaMs - System.currentTimeMillis()) / 1000)).build());
            }
        } else {
            if (started) { nav.navigationEnded(); started = false; }
            b.setNavigationInfo(new MessageInfo.Builder("RideGrid").setText("Start navigation on your phone (Daily ride mode)").build());
        }
        return b.build();
    }
}
