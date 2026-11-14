package app.seascout.marine;

import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

/**
 * r14.15.46: if Android kills the WebView's renderer while Sea Scout is in the background
 * (low memory), the WebView stays white when the user comes back. Recreate the activity
 * so the app reloads instead of showing a blank screen. The page also restores its last
 * scan from local storage, so the user lands back on the same area.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (bridge != null) {
            bridge.addWebViewListener(new WebViewListener() {
                @Override
                public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                    try {
                        if (webView != null) {
                            if (webView.getParent() instanceof ViewGroup) {
                                ((ViewGroup) webView.getParent()).removeView(webView);
                            }
                            webView.destroy();
                        }
                    } catch (Exception ignored) {
                    }
                    MainActivity.this.runOnUiThread(MainActivity.this::recreate);
                    return true;
                }
            });
        }
    }
}
