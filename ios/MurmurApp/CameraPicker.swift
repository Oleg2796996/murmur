import SwiftUI
import AVFoundation

/// Result of the camera picker: either a photo or a captured movie file.
enum CameraCapture {
    case photo(UIImage)
    case movie(URL)
}

/// UIKit camera wrapper (UIImagePickerController) — photos AND videos.
/// Simulator has no camera, so the view shows nothing usable there.
struct CameraPicker: UIViewControllerRepresentable {
    var onCapture: (CameraCapture) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        if UIImagePickerController.isSourceTypeAvailable(.camera) {
            picker.sourceType = .camera
            picker.mediaTypes = ["public.image", "public.movie"]
            picker.videoQuality = .typeMedium
        }
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController,
                                   didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage {
                parent.onCapture(.photo(image))
            } else if let url = info[.mediaURL] as? URL {
                parent.onCapture(.movie(url))
            }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}
