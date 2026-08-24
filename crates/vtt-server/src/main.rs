// `server::run` is wrapped by #[actix_web::main] inside the library, so from
// here it presents as a synchronous fn returning io::Result.
fn main() -> std::io::Result<()> {
    vtt_server::server::run()
}
