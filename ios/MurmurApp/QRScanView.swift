import SwiftUI
import AVFoundation
import UIKit

/// «Сканировать QR» — камера распознаёт QR-код инвайта и сразу открывает чат.
///
/// Формат — тот же, что парсит `ChatListView.extractInviteNpub()`:
/// `https://murmurchat.org/#invite=npub1…` (или голый npub).
///
/// РЕАЛИЗАЦИЯ: `AVCaptureMetadataOutput` — единственный путь, который
/// компилируется и работает одинаково на iOS 17–26+. VisionKit
/// `DataScannerViewController` не годится: в SDK Xcode 26 его вложенные типы
/// переезжали (`RecognizedDataType` стал `Set`, `RecognizedItem` перестал быть
/// member — 3 ошибки компиляции, Олег 16.11 21:10), а выигрыш — только рамка
/// подсветки, которую мы и так рисуем сами.
///
/// 2026-11-16 (Олег): «добавим кнопку рядом с "Пригласить друга" и
/// "Вставить ссылку" — чтобы когда сканируешь QR из приложения, то сразу
/// добавлялся чат».
struct QRScanView: UIViewControllerRepresentable {
    /// Вызывается ОДИН раз — с распознанной строкой инвайта.
    var onCode: (String) -> Void
    /// Сообщение об ошибке (камера недоступна, отказ в доступе и т.п.).
    var onError: (String) -> Void

    func makeUIViewController(context: Context) -> UIViewController {
        let host = AVQRScannerViewController()
        host.onCode = onCode
        host.onError = onError
        return host
    }

    func updateUIViewController(_ uiViewController: UIViewController, context: Context) {}
}

/// Полноэкранная камера + следящая рамка. Первый распознанный QR — колбэк и стоп.
final class AVQRScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?
    var onError: ((String) -> Void)?
    private var fired = false
    private let session = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private let frameView = UIView()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        // Следящая рамка прицела — видимый центр кадра.
        frameView.layer.borderColor = UIColor.white.withAlphaComponent(0.85).cgColor
        frameView.layer.borderWidth = 2
        frameView.layer.cornerRadius = 12
        frameView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(frameView)
        NSLayoutConstraint.activate([
            frameView.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            frameView.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            frameView.widthAnchor.constraint(equalToConstant: 260),
            frameView.heightAnchor.constraint(equalToConstant: 260),
        ])
        configureSession()
    }

    private func configureSession() {
        guard let device = AVCaptureDevice.default(for: .video) else {
            onError?("Камера недоступна на этом устройстве")
            return
        }
        do {
            let input = try AVCaptureDeviceInput(device: device)
            let output = AVCaptureMetadataOutput()
            session.addInput(input)
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
            let layer = AVCaptureVideoPreviewLayer(session: session)
            layer.videoGravity = .resizeAspectFill
            layer.frame = view.bounds
            layer.backgroundColor = UIColor.black.cgColor
            view.layer.insertSublayer(layer, at: 0)
            previewLayer = layer
            DispatchQueue.global(qos: .userInitiated).async { [session] in
                session.startRunning()
            }
        } catch {
            onError?("Не удалось запустить камеру: \(error.localizedDescription)")
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        DispatchQueue.global(qos: .userInitiated).async { [session] in
            if session.isRunning { session.stopRunning() }
        }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput,
                        didOutput metadataObjects: [AVMetadataObject],
                        from connection: AVCaptureConnection) {
        guard !fired else { return }
        guard let obj = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              obj.type == .qr, let value = obj.stringValue, !value.isEmpty else { return }
        fired = true
        DispatchQueue.global(qos: .userInitiated).async { [session] in
            if session.isRunning { session.stopRunning() }
        }
        DispatchQueue.main.async { [weak self] in
            self?.onCode?(value)
        }
    }
}
