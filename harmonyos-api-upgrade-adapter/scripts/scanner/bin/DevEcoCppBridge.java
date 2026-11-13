import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import com.huawei.deveco.programanalysis.apiscan.capiscan.CAPIScanner;

class DevEcoCppBridge {
    public static void main(String[] args) throws Exception {
        var scanner = CAPIScanner.getDefault();
        if (scanner == null) throw new IllegalStateException("DevEco C/C++ scanner unavailable");
        if (args[0].equals("--probe")) {
            if (!JSONObject.class.isAssignableFrom(CAPIScanner.class.getMethod("run", JSONObject.class).getReturnType()))
                throw new IllegalStateException("DevEco C/C++ scanner result contract changed");
            JSON.parseObject("{}");
            Class.forName("org.eclipse.cdt.core.dom.ast.IASTTranslationUnit");
            Class.forName("org.eclipse.core.runtime.IProgressMonitor");
            System.out.println("HARMONY_CPP_IDE_READY");
            return;
        }
        var input = JSON.parseObject(Files.readString(Path.of(args[0]), StandardCharsets.UTF_8));
        var result = scanner.run(input);
        System.out.write(JSON.toJSONString(result).getBytes(StandardCharsets.UTF_8));
    }
}
