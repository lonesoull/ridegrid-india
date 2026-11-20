package in.ridegrid.app.car;

import android.content.Intent;
import androidx.annotation.NonNull;
import androidx.car.app.CarAppService;
import androidx.car.app.Screen;
import androidx.car.app.Session;
import androidx.car.app.validation.HostValidator;

/** Android Auto entry point (navigation app category). */
public class RideGridCarAppService extends CarAppService {
    @NonNull
    @Override
    public HostValidator createHostValidator() {
        // sideloaded app: accept the Android Auto host on this phone
        return HostValidator.ALLOW_ALL_HOSTS_VALIDATOR;
    }

    @NonNull
    @Override
    public Session onCreateSession() {
        return new Session() {
            @NonNull
            @Override
            public Screen onCreateScreen(@NonNull Intent intent) { return new NavScreen(getCarContext()); }
        };
    }
}
