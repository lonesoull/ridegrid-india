package in.ridegrid.app.car;

import java.util.concurrent.CopyOnWriteArrayList;

/** Latest navigation state sent from the web app (Daily mode), read by the Android Auto screen. */
public final class NavState {
    public static volatile boolean navigating = false;
    public static volatile String turn = "straight";
    public static volatile String text = "";
    public static volatile String road = "";
    public static volatile double distM = 0;
    public static volatile double remainingM = 0;
    public static volatile long etaMs = 0;
    public static volatile int exit = 0;
    public static volatile int speedKmh = 0;
    public static volatile int limit = 0;

    public interface Listener { void onChange(); }
    private static final CopyOnWriteArrayList<Listener> listeners = new CopyOnWriteArrayList<>();
    public static void addListener(Listener l) { listeners.add(l); }
    public static void removeListener(Listener l) { listeners.remove(l); }
    public static void changed() { for (Listener l : listeners) l.onChange(); }
    private NavState() {}
}
