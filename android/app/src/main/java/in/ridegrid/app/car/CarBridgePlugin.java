package in.ridegrid.app.car;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Web app → Android Auto: the current turn, distance, road and arrival time. */
@CapacitorPlugin(name = "CarBridge")
public class CarBridgePlugin extends Plugin {
    @PluginMethod
    public void update(PluginCall call) {
        JSObject d = call.getData();
        NavState.navigating = d.optBoolean("navigating", false);
        NavState.turn = d.optString("turn", "straight");
        NavState.text = d.optString("text", "");
        NavState.road = d.optString("road", "");
        NavState.distM = d.optDouble("distM", 0);
        NavState.remainingM = d.optDouble("remainingM", 0);
        NavState.etaMs = d.optLong("etaMs", 0);
        NavState.exit = d.optInt("exit", 0);
        NavState.speedKmh = d.optInt("speedKmh", 0);
        NavState.limit = d.optInt("limit", 0);
        NavState.changed();
        call.resolve();
    }
}
