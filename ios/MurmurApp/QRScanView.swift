import SwiftUI
import AVFoundation
import CoreImage
import UIKit
import ObjectiveC.runtime

/// «Сканировать QR» — камера распознаёт QR-код инвайта и сразу открывает чат.
///
/// Формат — тот же, что парсит `ChatListView.extractInviteNpub()`:
/// `https://murmurchat.org/#invite=npub1…` (или голый npub).
///
/// Две реализации:
///   * iOS 16+: `DataScannerViewController` (Live Text API, нативная рамка);
///   * iOS 17–25 fallback: `AVCaptureMetadataOutput` — старый надёжный путь
///     (rect-of-interest и следящая рамка вручную).
///
/// 2026-11-16 (Олег): «добавим кнопку рядом с "Пригласить друга" и
/// "Вставить ссылку" — чтобы когда сканируешь QR из приложения, то сразу
/// добавлялся чат».
struct QRScanView: UIViewControllerRepresentable {
    /// Ключ для ассоциированной ссылки на delegate (не даём ему умереть).
    private static var delegateKey: UInt8 = 0
    /// Вызывается один раз — с распознанной строкой инвайта.
    var onCode: (String) -> Void
    /// Сообщение об ошибке (камера недоступна, отказ в доступе и т.п.).
    var onError: (String) -> Void

    func makeUIViewController(context: Context) -> UIViewController {
        if #available(iOS 16.0, *) {
            if let vc = Self.makeDataScanner(onCode: onCode, onError: onError) {
                return vc
            }
        }
        let host = AVFallbackScanner()
        host.onCode = onCode
        host.onError = onError
        return host
    }

    func updateUIViewController(_ uiViewController: UIViewController, context: Context) {}

    // MARK: - iOS 16+: DataScannerViewController

    @available(iOS 16.0, *)
    private static func makeDataScanner(onCode: @escaping (String) -> Void,
                                        onError: @escaping (String) -> Void) -> UIViewController? {
        guard DataScannerViewController.isAvailable else {
            onError("Сканер недоступен на этом устройстве — выберите QR из фото")
            return nil
        }
        let recognizer: [DataScannerViewController.RecognizedDataType] = [.barcode(symbologies: [.qr])]
        let config = DataScannerViewController(recognizedDataTypes: recognizer,
                                               qualityLevel: .balanced,
                                               recognizesMultipleItems: false,
                                               isHighFrameRateTrackingEnabled: true,
                                               isPinchToZoomEnabled: true,
                                               isGuidanceEnabled: true,
                                               isHighlightingEnabled: true)
        let wrapper = ScannerHostController(root: config)
        wrapper.onCode = onCode
        let delegate = DataScannerDelegate()
        delegate.onFound = { text in
            onCode(text)
        }
        config.delegate = delegate
        // Держим delegate живым — он сохраняется ассоциированной ссылкой
        // на wrapper (objc_setAssociatedObject проще, чем отдельный стор).
        objc_setAssociatedObject(wrapper, &delegateKey, delegate,
                                 .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        // Останавливаем сканирование после первого кода — иначе шит может
        // открыться несколько раз.
        wrapper.onFound = { [weak config] text in
            config?.stopScanning()
            onCode(text)
        }
        do {
            try config.startScanning()
        } catch {
            onError("Не удалось запустить камеру: \(error.localizedDescription)")
            return nil
        }
        return wrapper
    }
}

// MARK: - Host wrapper (держит камеру живой до исчезновения шита)

final class ScannerHostController: UINavigationController {
    var onCode: ((String) -> Void)?
    private var fired = false

    init(root: UIViewController) {
        super.init(rootViewController: root)
        // Полноэкранная камера с тёмным фоном.
        root.view.backgroundColor = .black
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    func onFound(_ text: String) {
        guard !fired else { return }
        fired = true
        onCode?(text)
    }
}

// MARK: - DataScanner delegate: распознанный QR → payload

@available(iOS 16.0, *)
final class DataScannerDelegate: NSObject, DataScannerViewControllerDelegate {
    var onFound: ((String) -> Void)?
    private var fired = false

    func dataScanner(_ dataScanner: DataScannerViewController,
                     didAdd added: [DataScannerViewController.RecognizedItem],
                     allItems: [DataScannerViewController.RecognizedItem]) {
        guard !fired else { return }
        for item in added {
            if case .barcode(let barcode) = item {
                // payload может быть nil при «corrupted»; тогда пробуем allItems.
                if let payload = barcode.payload ?? barcode.payloadCorrupted,
                   !payload.isEmpty {
                    fired = true
                    dataScanner.stopScanning()
                    onFound?(payload)
                    return
                }
            }
        }
        // Код мог прийти ТОЛЬКО в allItems (didAdd не сработал) — страхуемся.
        if !fired {
            for item in allItems {
                if case .barcode(let barcode) = item,
                   let payload = barcode.payload ?? barcode.payloadCorrupted,
                   !payload.isEmpty {
                    fired = true
                    dataScanner.stopScanning()
                    onFound?(payload)
                    return
                }
            }
        }
    }
}

// MARK: - Fallback: AVCaptureMetadataOutput (iOS 17–25 и когда DataScanner недоступен)

final class AVFallbackScanner: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?
    var onError: ((String) -> Void)?
    private var fired = false
    private let session = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private let frameView = UIView()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
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
              obj.type == .qr, let value = obj.stringValue else { return }
        fired = true
        DispatchQueue.main.async { [weak self] in
            self?.onCode?(value)
        }
    }
}
