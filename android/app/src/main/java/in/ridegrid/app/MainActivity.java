package in.ridegrid.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import in.ridegrid.app.car.CarBridgePlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CarBridgePlugin.class); // Android Auto bridge (Daily ride mode)
        super.onCreate(savedInstanceState);
    }
}
