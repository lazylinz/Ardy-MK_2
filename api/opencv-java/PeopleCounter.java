import org.opencv.core.Core;
import org.opencv.core.Mat;
import org.opencv.core.MatOfRect;
import org.opencv.core.Size;
import org.opencv.imgcodecs.Imgcodecs;
import org.opencv.imgproc.Imgproc;
import org.opencv.objdetect.CascadeClassifier;

public class PeopleCounter {
    static {
        System.loadLibrary(Core.NATIVE_LIBRARY_NAME);
    }

    public static void main(String[] args) {
        if (args.length < 2) {
            System.out.println("0");
            return;
        }

        String imagePath = args[0];
        String cascadePath = args[1];

        Mat image = Imgcodecs.imread(imagePath);
        if (image == null || image.empty()) {
            System.out.println("0");
            return;
        }

        CascadeClassifier classifier = new CascadeClassifier(cascadePath);
        if (classifier.empty()) {
            System.out.println("0");
            return;
        }

        Mat gray = new Mat();
        Imgproc.cvtColor(image, gray, Imgproc.COLOR_BGR2GRAY);
        Imgproc.equalizeHist(gray, gray);

        MatOfRect faces = new MatOfRect();
        classifier.detectMultiScale(
            gray,
            faces,
            1.1,
            3,
            0,
            new Size(30, 30),
            new Size()
        );

        int count = faces.toArray().length;
        System.out.println(Math.max(0, count));

        gray.release();
        image.release();
    }
}
