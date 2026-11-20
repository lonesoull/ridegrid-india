package in.ridegrid.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import in.ridegrid.app.car.CarBridgePlugin;
import in.ridegrid.app.car.RideDevicePlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CarBridgePlugin.class); // Android Auto bridge (Daily ride mode)
        registerPlugin(RideDevicePlugin.class); // turn notification, wake screen, light sensor, GPS status
        super.onCreate(savedInstanceState);
    }
}
