import org.opencv.core.Core;
import org.opencv.core.Mat;
import org.opencv.core.MatOfRect;
import org.opencv.core.Rect;
import org.opencv.core.Size;
import org.opencv.imgcodecs.Imgcodecs;
import org.opencv.imgproc.Imgproc;
import org.opencv.objdetect.CascadeClassifier;

public class FaceAuthProcessor {
    static {
        System.loadLibrary(Core.NATIVE_LIBRARY_NAME);
    }

    private static String escapeJson(String raw) {
        return String.valueOf(raw).replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private static String errorJson(String message) {
        return "{\"ok\":false,\"error\":\"" + escapeJson(message) + "\"}";
    }

    private static Rect findLargestFace(Mat gray, CascadeClassifier classifier) {
        MatOfRect faces = new MatOfRect();
        classifier.detectMultiScale(gray, faces, 1.1, 4, 0, new Size(40, 40), new Size());
        Rect[] list = faces.toArray();
        if (list.length == 0) return null;
        Rect largest = list[0];
        double largestArea = largest.area();
        for (int i = 1; i < list.length; i++) {
            double area = list[i].area();
            if (area > largestArea) {
                largest = list[i];
                largestArea = area;
            }
        }
        return largest;
    }

    private static double[] buildNormalizedVector(Mat faceGray) {
        Mat resized = new Mat();
        Imgproc.resize(faceGray, resized, new Size(16, 16), 0, 0, Imgproc.INTER_AREA);

        double[] values = new double[(int) (resized.total())];
        resized.get(0, 0, values);

        double mean = 0.0;
        for (double v : values) mean += v;
        mean /= values.length;

        double variance = 0.0;
        for (double v : values) {
            double d = v - mean;
            variance += d * d;
        }
        variance /= values.length;
        double std = Math.sqrt(Math.max(variance, 1e-12));

        double[] normalized = new double[values.length];
        for (int i = 0; i < values.length; i++) {
            normalized[i] = (values[i] - mean) / std;
        }

        resized.release();
        return normalized;
    }

    public static void main(String[] args) {
        if (args.length < 2) {
            System.out.println(errorJson("Usage: FaceAuthProcessor <imagePath> <cascadePath>"));
            return;
        }

        String imagePath = args[0];
        String cascadePath = args[1];

        Mat image = Imgcodecs.imread(imagePath);
        if (image == null || image.empty()) {
            System.out.println(errorJson("Unable to read image."));
            return;
        }

        CascadeClassifier classifier = new CascadeClassifier(cascadePath);
        if (classifier.empty()) {
            image.release();
            System.out.println(errorJson("Unable to load Haar cascade."));
            return;
        }

        Mat gray = new Mat();
        Imgproc.cvtColor(image, gray, Imgproc.COLOR_BGR2GRAY);
        Imgproc.equalizeHist(gray, gray);

        Rect largestFace = findLargestFace(gray, classifier);
        if (largestFace == null) {
            gray.release();
            image.release();
            System.out.println(errorJson("No face detected."));
            return;
        }

        Mat faceRegion = new Mat(gray, largestFace);
        double[] vector = buildNormalizedVector(faceRegion);

        StringBuilder sb = new StringBuilder();
        sb.append("{\"ok\":true,\"vector\":[");
        for (int i = 0; i < vector.length; i++) {
            if (i > 0) sb.append(',');
            sb.append(vector[i]);
        }
        sb.append("]}");
        System.out.println(sb);

        faceRegion.release();
        gray.release();
        image.release();
    }
}
